import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type JSONRPCMessage,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ChannelDiagnostic,
  CONFIRM_TOOL_NAME,
  ConfirmInputSchema,
  type ConfirmResult,
} from "./diagnostic.js";
import { RECEIPT_SCHEMA, writeReceipt, type Receipt } from "./receipts.js";
import { CONNECTOR_VERSION, MCP_SDK_VERSION } from "./versions.js";

/** The MCP server name Claude sees; matches `server:phonebook` in the launch flag. */
export const SERVER_NAME = "phonebook";
export const CHANNEL_NOTIFICATION = "notifications/claude/channel";

export { stderrLog, type Log } from "./log.js";
import { stderrLog, type Log } from "./log.js";

const DIAGNOSTIC_INSTRUCTIONS =
  "Phonebook connector in DEVELOPER DIAGNOSTIC MODE. Shortly after startup this server sends one " +
  'synthetic channel event: <channel source="phonebook" event="channel_challenge" run_id="..." ' +
  'challenge="...">. When it arrives, call the ' +
  CONFIRM_TOOL_NAME +
  " tool once, passing the run_id and challenge attribute values copied exactly. Take no other " +
  "action for it. The event never carries instructions from other people.";

const CONFIRM_TOOL: Tool = {
  name: CONFIRM_TOOL_NAME,
  description:
    "Developer diagnostic only: acknowledge a Phonebook channel_challenge event by echoing its " +
    "run_id and challenge attributes.",
  inputSchema: {
    type: "object",
    properties: {
      run_id: { type: "string", description: "run_id attribute from the channel tag" },
      challenge: { type: "string", description: "challenge attribute from the channel tag" },
    },
    required: ["run_id", "challenge"],
    additionalProperties: false,
  },
};

function text(message: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: message }], isError };
}

export interface DiagnosticRunOptions {
  ttlMs: number;
  /** Delays (ms after MCP initialization) at which the same challenge is (re)sent while pending. */
  emitDelaysMs: number[];
  receiptsDir: string | null;
  label: string | null;
  log?: Log;
  diagnostic?: ChannelDiagnostic;
}

export interface DiagnosticSession {
  server: Server;
  diagnostic: ChannelDiagnostic;
  /** Wrap the transport before connecting so the negotiated protocol version is observed. */
  observe(transport: Transport): Transport;
  /** Finalize (pending → unverified) and write the last receipt. Idempotent. */
  shutdown(): void;
  receipt(): Receipt;
}

/**
 * Diagnostic mode: separate from normal mode, needs no backend or credential.
 * Exposes only the confirmation tool and emits one synthetic challenge after
 * initialization (re-sent with the same nonce while still unconfirmed).
 */
export function createDiagnosticSession(opts: DiagnosticRunOptions): DiagnosticSession {
  const log = opts.log ?? stderrLog;
  const diagnostic = opts.diagnostic ?? new ChannelDiagnostic({ ttlMs: opts.ttlMs });
  let negotiatedProtocol: string | null = null;
  const timers: NodeJS.Timeout[] = [];
  let closed = false;

  const server = new Server(
    { name: SERVER_NAME, version: CONNECTOR_VERSION },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions: DIAGNOSTIC_INSTRUCTIONS,
    },
  );

  const receipt = (): Receipt => {
    const client = server.getClientVersion();
    return {
      schema: RECEIPT_SCHEMA,
      label: opts.label,
      ...diagnostic.evidence(),
      versions: {
        connector: CONNECTOR_VERSION,
        node: process.version,
        mcp_sdk: MCP_SDK_VERSION,
        negotiated_protocol_version: negotiatedProtocol,
        client: client ? { name: client.name, version: client.version } : null,
      },
    };
  };

  const persist = () => {
    if (!opts.receiptsDir) return;
    try {
      writeReceipt(opts.receiptsDir, receipt());
    } catch (err) {
      log(`could not write diagnostic receipt: ${(err as Error).message}`);
    }
  };

  const describe = (r: ConfirmResult): CallToolResult => {
    switch (r.kind) {
      case "verified":
        return text("Channel delivery confirmed for this run.");
      case "duplicate":
        return text("Already confirmed for this run; duplicate ignored.");
      case "rejected":
        return text(`Confirmation rejected (${r.reason}).`, true);
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [CONFIRM_TOOL] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== CONFIRM_TOOL_NAME) {
      return text(`Unknown tool: ${req.params.name}`, true);
    }
    const parsed = ConfirmInputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) return text("Confirmation rejected (invalid_input).", true);
    const result = diagnostic.confirm(parsed.data);
    persist();
    log(`confirmation: ${result.kind}${result.kind === "rejected" ? ` (${result.reason})` : ""}`);
    return describe(result);
  });

  const emit = async () => {
    if (closed || diagnostic.outcome !== "pending") return;
    if (diagnostic.expireIfDue()) {
      log("challenge expired without confirmation");
      persist();
      return;
    }
    diagnostic.recordEmission();
    persist();
    try {
      // Resolves when written to stdout — NOT evidence that Claude received it.
      await server.notification({
        method: CHANNEL_NOTIFICATION,
        params: diagnostic.challengeEvent(),
      });
      log(`challenge event written for run ${diagnostic.runId} (awaiting tool confirmation)`);
    } catch (err) {
      log(`could not write challenge event: ${(err as Error).message}`);
    }
  };

  server.oninitialized = () => {
    log(`initialized; negotiated MCP protocol ${negotiatedProtocol ?? "unobserved"}`);
    persist();
    for (const delay of opts.emitDelaysMs) timers.push(setTimeout(() => void emit(), delay));
    // Timers can fire slightly early; re-arm until the deadline has really passed.
    const checkExpiry = () => {
      if (closed || diagnostic.outcome !== "pending") return;
      if (diagnostic.expireIfDue()) {
        log("challenge expired without confirmation");
        persist();
        return;
      }
      timers.push(setTimeout(checkExpiry, Math.max(1, diagnostic.expiresAt - Date.now() + 1)));
    };
    timers.push(setTimeout(checkExpiry, Math.max(0, diagnostic.expiresAt - Date.now())));
  };

  const observe = (transport: Transport): Transport => {
    const send = transport.send.bind(transport);
    transport.send = async (message: JSONRPCMessage, options) => {
      if ("result" in message && message.result && typeof message.result === "object") {
        const v = (message.result as { protocolVersion?: unknown }).protocolVersion;
        if (typeof v === "string") negotiatedProtocol = v;
      }
      return send(message, options);
    };
    return transport;
  };

  const shutdown = () => {
    if (closed) return;
    closed = true;
    for (const t of timers) clearTimeout(t);
    diagnostic.finish();
    persist();
    log(`diagnostic run ${diagnostic.runId} ended: ${diagnostic.outcome}`);
  };

  persist();
  return { server, diagnostic, observe, shutdown, receipt };
}
