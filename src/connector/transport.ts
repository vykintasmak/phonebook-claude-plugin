import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import {
  CLOSE_CODES,
  parseFrame,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  TRANSPORT_LIMITS,
  TRANSPORT_TIMING,
  transportUrl,
  EXCHANGE_CAPABILITY,
  GRANTS_CAPABILITY,
  EXCHANGE_LIMITS,
  type ClientMessage,
  type ServerMessage,
} from "@agent-phonebook/protocol";
import { randomUUID } from "node:crypto";
import type { Log } from "./log.js";

export type TransportPhase =
  "idle" | "connecting" | "open" | "backoff" | "terminal" | "suspended" | "stopped";

/**
 * Phase 3: bounded unconfirmed activation. At most this many sessions in a row may
 * deliver a readiness challenge without a backend-confirmed proof; only a confirmed
 * proof (or a process restart) resets the count. Transport success never does.
 */
export const MAX_UNCONFIRMED_ACTIVATIONS = 3;
/** Grace after the server's challenge deadline before suspending locally. */
export const CHALLENGE_EXPIRY_GRACE_MS = 2_000;

export interface TransportState {
  phase: TransportPhase;
  /** Increments for every new socket; challenges from older sockets are void. */
  generation: number;
  sessionId: string | null;
  connectedAt: number | null;
  lastHeartbeatAckAt: number | null;
  leaseExpiresAt: number | null;
  nextAttemptAt: number | null;
  terminalReason: string | null;
  lastError: string | null;
}

export type Challenge = Extract<ServerMessage, { type: "channel_challenge" }> & {
  generation: number;
};

/** Server-pushed Phase 2 events, tagged with the socket generation they arrived on. */
export type ExchangeEvent = Extract<
  ServerMessage,
  { type: "question" | "answer" | "decline" | "request_status" }
> & { generation: number };

/** Business operations (without v/request_id, which the transport adds). */
export type BusinessOp =
  | Omit<Extract<ClientMessage, { type: "register" }>, "v" | "request_id">
  | Omit<Extract<ClientMessage, { type: "set_receiving" }>, "v" | "request_id">
  | Omit<Extract<ClientMessage, { type: "status" }>, "v" | "request_id">
  | Omit<Extract<ClientMessage, { type: "ask" }>, "v" | "request_id">
  | Omit<Extract<ClientMessage, { type: "reply" }>, "v" | "request_id">
  | Omit<Extract<ClientMessage, { type: "get_request" }>, "v" | "request_id">;

export type CallOutcome =
  | {
      kind: "ok";
      message: Extract<
        ServerMessage,
        { type: "registration_result" | "status_result" | "request_result" }
      >;
    }
  | { kind: "rejected"; code: string; message: string; retryAfterMs?: number }
  | { kind: "timeout" }
  | { kind: "not_connected" };

export type ConfirmOutcome =
  | { kind: "confirmed" | "already_confirmed"; verifiedAt: number }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "timeout" }
  | { kind: "not_connected" };

export interface TransportTiming {
  heartbeatAckTimeoutMs: number;
  confirmTimeoutMs: number;
  ackTimeoutMs: number;
  /** Grace after a challenge deadline before local suspension. */
  challengeGraceMs: number;
  handshakeTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxRetryAfterMs: number;
}

export const DEFAULT_TIMING: TransportTiming = {
  heartbeatAckTimeoutMs: TRANSPORT_TIMING.heartbeatAckTimeoutMs,
  confirmTimeoutMs: TRANSPORT_TIMING.confirmTimeoutMs,
  ackTimeoutMs: EXCHANGE_LIMITS.ackTimeoutMs,
  challengeGraceMs: CHALLENGE_EXPIRY_GRACE_MS,
  handshakeTimeoutMs: 10_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  maxRetryAfterMs: 5 * 60_000,
};

export interface TransportOptions {
  origin: string;
  credential: string;
  log: Log;
  timing?: Partial<TransportTiming>;
  random?: () => number;
  onChallenge?: (challenge: Challenge) => void;
  onExchangeEvent?: (event: ExchangeEvent) => void;
  onStateChange?: (state: TransportState) => void;
}

const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

/** Exponential backoff with full jitter, capped. */
export function backoffDelay(
  attempt: number,
  timing: TransportTiming,
  random: () => number,
): number {
  const ceiling = Math.min(timing.backoffMaxMs, timing.backoffBaseMs * 2 ** Math.min(attempt, 20));
  return Math.max(100, Math.floor(random() * ceiling));
}

/**
 * One authenticated WebSocket to the pilot backend, with heartbeats and
 * bounded reconnects. Exactly one socket/attempt exists at a time. Terminal
 * errors (bad/revoked credential, misconfiguration, protocol or TLS failure)
 * stop retrying instead of looping.
 */
export class TransportClient {
  private readonly opts: TransportOptions;
  private readonly timing: TransportTiming;
  private readonly random: () => number;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private clientReady = false;
  private readySentForGeneration = -1;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private ackTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pending = new Map<
    string,
    { resolve: (m: ServerMessage | null) => void; timer: NodeJS.Timeout }
  >();
  private challengeSeen = false;
  private retryAfterMs: number | null = null;
  /** Sessions that delivered a challenge since the last confirmed proof in this process. */
  private unconfirmedActivations = 0;
  private confirmedThisGeneration = false;
  private challengeExpiryTimer: NodeJS.Timeout | null = null;
  private serverClockOffsetMs = 0;
  readonly state: TransportState = {
    phase: "idle",
    generation: 0,
    sessionId: null,
    connectedAt: null,
    lastHeartbeatAckAt: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    terminalReason: null,
    lastError: null,
  };

  constructor(opts: TransportOptions) {
    this.opts = opts;
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.random = opts.random ?? Math.random;
  }

  start(): void {
    if (this.state.phase !== "idle") return;
    this.connect();
  }

  /** MCP initialization finished and the channel bridge/tool handler are ready. */
  setClientReady(): void {
    this.clientReady = true;
    this.maybeSendClientReady();
  }

  stop(): void {
    if (this.state.phase === "stopped") return;
    this.update({ phase: "stopped", nextAttemptAt: null });
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.failPending();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, "connector shutting down");
      else ws.terminate();
    }
  }

  /** Sends a confirmation only on the socket the challenge arrived on. */
  async confirm(challenge: Challenge, nonce: string): Promise<ConfirmOutcome> {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      challenge.generation !== this.state.generation ||
      challenge.session_id !== this.state.sessionId
    ) {
      return { kind: "not_connected" };
    }
    const requestId = randomUUID();
    const reply = await this.request(
      {
        v: PROTOCOL_VERSION,
        type: "channel_confirm",
        request_id: requestId,
        session_id: challenge.session_id,
        challenge_id: challenge.challenge_id,
        nonce,
      },
      requestId,
      this.timing.confirmTimeoutMs,
    );
    if (!reply) return { kind: "timeout" };
    if (reply.type === "channel_confirmed") {
      if (challenge.generation === this.state.generation) {
        // Backend-confirmed readiness: the only thing that resets the activation budget.
        this.confirmedThisGeneration = true;
        this.unconfirmedActivations = 0;
        if (this.challengeExpiryTimer) clearTimeout(this.challengeExpiryTimer);
        this.challengeExpiryTimer = null;
      }
      return { kind: reply.outcome, verifiedAt: reply.verified_at };
    }
    if (reply.type === "error")
      return { kind: "rejected", code: reply.code, message: reply.message };
    return { kind: "timeout" };
  }

  /**
   * One business operation with a finite acknowledgement timeout. Never
   * replayed automatically after a reconnect; a timeout is not a rejection.
   */
  async call(op: BusinessOp): Promise<CallOutcome> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.state.sessionId) {
      return { kind: "not_connected" };
    }
    const requestId = randomUUID();
    const reply = await this.request(
      { v: PROTOCOL_VERSION, request_id: requestId, ...op } as ClientMessage,
      requestId,
      this.timing.ackTimeoutMs,
    );
    if (!reply) return { kind: "timeout" };
    if (reply.type === "error") {
      return {
        kind: "rejected",
        code: reply.code,
        message: reply.message,
        ...(reply.retry_after_ms !== undefined ? { retryAfterMs: reply.retry_after_ms } : {}),
      };
    }
    if (
      reply.type === "registration_result" ||
      reply.type === "status_result" ||
      reply.type === "request_result"
    ) {
      return { kind: "ok", message: reply };
    }
    return { kind: "timeout" };
  }

  // ---- connection lifecycle -------------------------------------------------

  private connect(): void {
    if (
      this.state.phase === "stopped" ||
      this.state.phase === "terminal" ||
      this.state.phase === "suspended"
    )
      return;
    const generation = this.state.generation + 1;
    this.challengeSeen = false;
    this.confirmedThisGeneration = false;
    this.retryAfterMs = null;
    this.update({
      phase: "connecting",
      generation,
      sessionId: null,
      connectedAt: null,
      nextAttemptAt: null,
      leaseExpiresAt: null,
    });
    const ws = new WebSocket(transportUrl(this.opts.origin), {
      headers: { authorization: `Bearer ${this.opts.credential}` },
      followRedirects: false,
      maxPayload: TRANSPORT_LIMITS.maxMessageBytes,
      handshakeTimeout: this.timing.handshakeTimeoutMs,
      perMessageDeflate: false,
      // TLS verification stays at Node's secure defaults; no Origin header is sent.
    });
    this.ws = ws;
    let terminal: string | null = null;

    ws.on("unexpected-response", (_req, res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const retryAfter = Number(res.headers["retry-after"]);
      res.resume();
      if (status === 401 || status === 403)
        terminal = `backend rejected the credential (HTTP ${status}); it may be invalid or revoked`;
      else if (status >= 300 && status < 400)
        terminal = `backend answered with a redirect (HTTP ${status}); refusing to follow. Check backendUrl`;
      else if (status === 400 || status === 404 || status === 405 || status === 426)
        terminal = `backend rejected the transport request (HTTP ${status}); check backendUrl`;
      else if (status === 429 || status === 503) {
        this.retryAfterMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, this.timing.maxRetryAfterMs)
            : null;
      }
      this.update({ lastError: `HTTP ${status}` });
      ws.terminate();
    });
    ws.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code && TLS_ERROR_CODES.has(err.code))
        terminal = `TLS verification failed (${err.code})`;
      this.update({ lastError: err.code ?? err.message });
    });
    ws.on("open", () => {
      this.update({ phase: "open", connectedAt: Date.now() });
    });
    ws.on("message", (data, isBinary) => {
      if (this.ws !== ws) return;
      if (isBinary) {
        this.opts.log("ignored a binary frame from the backend");
        return;
      }
      this.onMessage(ws, data.toString());
    });
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.failPending();
      if (this.state.phase === "stopped" || this.state.phase === "suspended") return;
      if (code === CLOSE_CODES.revoked) terminal ??= "credential revoked by the pilot admin";
      if (
        code === CLOSE_CODES.protocolError ||
        code === CLOSE_CODES.unsupportedData ||
        code === CLOSE_CODES.messageTooBig
      ) {
        terminal ??= `backend closed the connection for a protocol error (${code}); check connector version`;
      }
      if (terminal) {
        this.update({ phase: "terminal", terminalReason: terminal, sessionId: null });
        this.opts.log(`transport stopped: ${terminal}`);
        return;
      }
      if (
        this.challengeSeen &&
        !this.confirmedThisGeneration &&
        this.unconfirmedActivations >= MAX_UNCONFIRMED_ACTIVATIONS
      ) {
        this.suspend(
          `${MAX_UNCONFIRMED_ACTIVATIONS} channel activations in a row ended without confirmation`,
        );
        return;
      }
      this.scheduleReconnect(code === CLOSE_CODES.rateLimited);
    });
  }

  private scheduleReconnect(rateLimited: boolean): void {
    let delay = backoffDelay(this.attempt++, this.timing, this.random);
    if (this.retryAfterMs !== null) delay = Math.max(delay, this.retryAfterMs);
    if (rateLimited) delay = Math.max(delay, 60_000);
    this.update({ phase: "backoff", sessionId: null, nextAttemptAt: Date.now() + delay });
    this.opts.log(
      `transport disconnected; reconnecting in ${Math.round(delay / 1000)}s (new session, new challenge)`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onMessage(ws: WebSocket, text: string): void {
    const parsed = parseFrame(ServerMessageSchema, text);
    if (!parsed.ok) {
      // Unknown content is dropped, never forwarded to Claude.
      this.opts.log(`ignored an invalid backend frame (${parsed.code})`);
      return;
    }
    const msg = parsed.message;
    switch (msg.type) {
      case "session_opened":
        if (this.state.sessionId) return;
        this.attempt = 0;
        this.serverClockOffsetMs = msg.server_time - Date.now();
        this.update({ sessionId: msg.session_id, leaseExpiresAt: msg.server_time + msg.lease_ms });
        this.startHeartbeats(ws, msg.heartbeat_interval_ms);
        this.opts.log(`authenticated session ${msg.session_id}`);
        this.maybeSendClientReady();
        return;
      case "channel_challenge":
        if (msg.session_id !== this.state.sessionId || this.challengeSeen) {
          this.opts.log("ignored a challenge that does not belong to this session");
          return;
        }
        this.challengeSeen = true;
        this.unconfirmedActivations++;
        this.armChallengeExpiry(msg.expires_at);
        this.opts.onChallenge?.({ ...msg, generation: this.state.generation });
        return;
      case "heartbeat_ack":
        if (this.ackTimer) clearTimeout(this.ackTimer);
        this.ackTimer = null;
        this.update({ lastHeartbeatAckAt: Date.now(), leaseExpiresAt: msg.lease_expires_at });
        this.resolvePending(msg.request_id, msg);
        return;
      case "channel_confirmed":
      case "registration_result":
      case "status_result":
      case "request_result":
        this.resolvePending(msg.request_id, msg);
        return;
      case "question":
      case "answer":
      case "decline":
      case "request_status":
        // Bound to this exact session; anything else is dropped, never forwarded.
        if (msg.session_id !== this.state.sessionId) {
          this.opts.log(`ignored a ${msg.type} event for another session`);
          return;
        }
        this.opts.onExchangeEvent?.({ ...msg, generation: this.state.generation });
        return;
      case "error":
        if (msg.request_id && this.pending.has(msg.request_id)) {
          this.resolvePending(msg.request_id, msg);
          return;
        }
        this.opts.log(`backend error: ${msg.code}`);
        return;
    }
  }

  private maybeSendClientReady(): void {
    if (!this.clientReady || !this.state.sessionId || !this.ws) return;
    if (this.readySentForGeneration === this.state.generation) return;
    this.readySentForGeneration = this.state.generation;
    this.send({
      v: PROTOCOL_VERSION,
      type: "client_ready",
      capabilities: [EXCHANGE_CAPABILITY, GRANTS_CAPABILITY],
    });
  }

  private startHeartbeats(ws: WebSocket, intervalMs: number): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      this.send({ v: PROTOCOL_VERSION, type: "heartbeat", request_id: randomUUID() });
      if (!this.ackTimer) {
        this.ackTimer = setTimeout(() => {
          this.ackTimer = null;
          this.opts.log("heartbeat acknowledgement missing; treating the connection as lost");
          ws.terminate();
        }, this.timing.heartbeatAckTimeoutMs);
      }
    }, intervalMs);
  }

  private request(
    message: ClientMessage,
    requestId: string,
    timeoutMs: number,
  ): Promise<ServerMessage | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      this.send(message);
    });
  }

  private resolvePending(requestId: string, msg: ServerMessage): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(msg);
  }

  private failPending(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ackTimer) clearTimeout(this.ackTimer);
    if (this.challengeExpiryTimer) clearTimeout(this.challengeExpiryTimer);
    this.heartbeatTimer = null;
    this.ackTimer = null;
    this.challengeExpiryTimer = null;
  }

  /** Suspend locally when this session's challenge passes its deadline unconfirmed. */
  private armChallengeExpiry(expiresAtServer: number): void {
    if (this.challengeExpiryTimer) clearTimeout(this.challengeExpiryTimer);
    const generation = this.state.generation;
    const delay =
      Math.max(0, expiresAtServer - (Date.now() + this.serverClockOffsetMs)) +
      this.timing.challengeGraceMs;
    this.challengeExpiryTimer = setTimeout(() => {
      this.challengeExpiryTimer = null;
      if (generation === this.state.generation && !this.confirmedThisGeneration) {
        this.suspend("the channel readiness check expired without confirmation");
      }
    }, delay);
  }

  /**
   * Stop automatic activation: close this connector's socket, cancel all timers and
   * keep the MCP process responsive. Recovery is an explicit restart of the Claude
   * session with the channel flag (fresh proof and fresh registration).
   */
  private suspend(why: string): void {
    if (this.state.phase === "suspended" || this.state.phase === "stopped") return;
    const reason = `channel_unconfirmed: ${why}`;
    this.update({
      phase: "suspended",
      terminalReason: reason,
      sessionId: null,
      nextAttemptAt: null,
    });
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.failPending();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, "channel_unconfirmed");
      else ws.terminate();
    }
    this.opts.log(
      `suspended (${reason}). No further reconnects or readiness prompts from this process. ` +
        "To recover, restart the Claude session in this project with the channel-enabled launch command.",
    );
  }

  private update(patch: Partial<TransportState>): void {
    Object.assign(this.state, patch);
    this.opts.onStateChange?.({ ...this.state });
  }
}
