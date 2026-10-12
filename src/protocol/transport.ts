import { z } from "zod";
import {
  AnswerEventSchema,
  AskOpSchema,
  DeclineEventSchema,
  GetRequestOpSchema,
  KNOWN_CAPABILITIES,
  QuestionEventSchema,
  RegisterOpSchema,
  RegistrationResultSchema,
  ReplyOpSchema,
  RequestResultSchema,
  RequestStatusEventSchema,
  SetReceivingOpSchema,
  StatusOpSchema,
  StatusResultSchema,
} from "./exchange.js";
import { ChallengeIdSchema, NonceSchema, RequestIdSchema, SessionIdSchema } from "./ids.js";

/**
 * Phase 1 transport protocol (version 1): session management, channel
 * readiness challenge, and application heartbeats only. There is deliberately
 * no general message bus and no question/answer schema yet.
 */
export const PROTOCOL_VERSION = 1;

export const TRANSPORT_LIMITS = {
  /** Max bytes per application WebSocket message. */
  maxMessageBytes: 16 * 1024,
  /** Max bytes per admin JSON request body. */
  maxAdminBodyBytes: 8 * 1024,
  maxSocketsPerParticipant: 5,
  /** Whole-backend accepted WebSockets (authenticated, verified or not). */
  maxSocketsTotal: 256,
  /** Application messages per session per rolling minute window. */
  maxMessagesPerMinute: 60,
  maxParticipants: 100,
} as const;

export const TRANSPORT_TIMING = {
  heartbeatIntervalMs: 30_000,
  leaseMs: 90_000,
  challengeTtlMs: 120_000,
  /** Connector-side wait for a confirmation outcome before reporting a timeout. */
  confirmTimeoutMs: 5_000,
  /** Connector-side wait for a heartbeat_ack before treating the socket as half-open. */
  heartbeatAckTimeoutMs: 10_000,
} as const;

export {
  ChallengeIdSchema,
  NonceSchema,
  ParticipantIdSchema,
  RequestIdSchema,
  SessionIdSchema,
} from "./ids.js";

const v = z.literal(PROTOCOL_VERSION);
const timestamp = z.number().int().nonnegative();

// ---- server → connector -------------------------------------------------

export const SessionOpenedSchema = z
  .object({
    v,
    type: z.literal("session_opened"),
    session_id: SessionIdSchema,
    heartbeat_interval_ms: z.number().int().positive(),
    lease_ms: z.number().int().positive(),
    server_time: timestamp,
  })
  .strict();

export const ChannelChallengeSchema = z
  .object({
    v,
    type: z.literal("channel_challenge"),
    session_id: SessionIdSchema,
    challenge_id: ChallengeIdSchema,
    nonce: NonceSchema,
    expires_at: timestamp,
  })
  .strict();

export const ChannelConfirmedSchema = z
  .object({
    v,
    type: z.literal("channel_confirmed"),
    request_id: RequestIdSchema,
    challenge_id: ChallengeIdSchema,
    outcome: z.enum(["confirmed", "already_confirmed"]),
    verified_at: timestamp,
  })
  .strict();

export const HeartbeatAckSchema = z
  .object({
    v,
    type: z.literal("heartbeat_ack"),
    request_id: RequestIdSchema,
    server_time: timestamp,
    lease_expires_at: timestamp,
  })
  .strict();

export const TRANSPORT_ERROR_CODES = [
  "invalid_message",
  "unsupported_version",
  "rate_limited",
  "session_mismatch",
  "challenge_already_issued",
  "challenge_not_found",
  "challenge_expired",
  "challenge_failed",
  "wrong_nonce",
  "revoked",
  "lease_expired",
  "internal_error",
  // Phase 2 (exchange.v1)
  "unsupported_operation",
  "invalid_request",
  "channel_not_ready",
  "not_registered",
  "profile_locked",
  "invalid_approved_sender",
  "idempotency_conflict",
  "requester_busy",
  "request_not_found",
  "request_closed",
  "reply_conflict",
  "too_large",
  "capacity",
  // Phase 4
  "invalid_approved_email",
  "conflicting_grants",
  "credential_expired",
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

export const TransportErrorSchema = z
  .object({
    v,
    type: z.literal("error"),
    request_id: RequestIdSchema.optional(),
    code: z.enum(TRANSPORT_ERROR_CODES),
    message: z.string().max(200),
    retry_after_ms: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ServerMessageSchema = z.discriminatedUnion("type", [
  SessionOpenedSchema,
  ChannelChallengeSchema,
  ChannelConfirmedSchema,
  HeartbeatAckSchema,
  TransportErrorSchema,
  RegistrationResultSchema,
  StatusResultSchema,
  RequestResultSchema,
  QuestionEventSchema,
  AnswerEventSchema,
  DeclineEventSchema,
  RequestStatusEventSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---- connector → server -------------------------------------------------

export const ClientReadySchema = z
  .object({
    v,
    type: z.literal("client_ready"),
    /** Phase 2: business operations/events are enabled only for declared capabilities. */
    capabilities: z.array(z.enum(KNOWN_CAPABILITIES)).max(4).optional(),
  })
  .strict();

export const ChannelConfirmSchema = z
  .object({
    v,
    type: z.literal("channel_confirm"),
    request_id: RequestIdSchema,
    session_id: SessionIdSchema,
    challenge_id: ChallengeIdSchema,
    nonce: NonceSchema,
  })
  .strict();

export const HeartbeatSchema = z
  .object({ v, type: z.literal("heartbeat"), request_id: RequestIdSchema })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion("type", [
  ClientReadySchema,
  ChannelConfirmSchema,
  HeartbeatSchema,
  RegisterOpSchema,
  SetReceivingOpSchema,
  StatusOpSchema,
  AskOpSchema,
  ReplyOpSchema,
  GetRequestOpSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Application close codes used by the server (4000–4999 are application-defined). */
export const CLOSE_CODES = {
  revoked: 4003,
  leaseExpired: 4008,
  rateLimited: 4029,
  protocolError: 4400,
  /** Standard codes. */
  unsupportedData: 1003,
  messageTooBig: 1009,
} as const;

export type ParsedMessage<T> =
  | { ok: true; message: T }
  | { ok: false; code: "invalid_message" | "unsupported_version"; message: string };

/** Parses one text frame. Never throws; never returns unknown content. */
export function parseFrame<T>(schema: z.ZodType<T>, text: string): ParsedMessage<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid_message", message: "Malformed JSON." };
  }
  if (typeof raw === "object" && raw !== null && "v" in raw && raw.v !== PROTOCOL_VERSION) {
    return { ok: false, code: "unsupported_version", message: "Unsupported protocol version." };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: "invalid_message", message: "Invalid or unknown message." };
  }
  return { ok: true, message: parsed.data };
}
