import { z } from "zod";
import { ParticipantIdSchema, RequestIdSchema, SessionIdSchema } from "./ids.js";

/**
 * Phase 2: explicit registration and one-question/one-answer exchanges.
 * These are pilot choices, not platform limits. Sizes count UTF-8 bytes.
 */
export const EXCHANGE_CAPABILITY = "exchange.v1";
/** Phase 4: registration views carry the owner's grant summary (self / exact emails). */
export const GRANTS_CAPABILITY = "grants.v1";
export const KNOWN_CAPABILITIES = [EXCHANGE_CAPABILITY, GRANTS_CAPABILITY] as const;

export const EXCHANGE_LIMITS = {
  nameMaxChars: 64,
  descriptionMaxBytes: 512,
  topicsMin: 1,
  topicsMax: 8,
  topicMaxChars: 48,
  approvedSendersMax: 32,
  /** Phase 4: exact verified emails per registration, and lookups per participant per minute. */
  approvedEmailsMax: 10,
  emailLookupsPerMinute: 20,
  questionMaxBytes: 4 * 1024,
  replyMaxBytes: 8 * 1024,
  requestLifetimeMs: 10 * 60_000,
  askAttemptsPerMinute: 5,
  terminalRetentionMs: 7 * 24 * 60 * 60_000,
  /** Retained request rows in every state (terminal rows are kept terminalRetentionMs). */
  maxRetainedRequests: 100_000,
  /** Terminal rows deleted per retention batch (alarm or admission-time cleanup). */
  retentionPruneBatch: 1_000,
  profileRetentionAfterCloseMs: 24 * 60 * 60_000,
  directoryMax: 100,
  /** Connector-side wait for a backend acknowledgement of any business operation. */
  ackTimeoutMs: 5_000,
} as const;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// ---- identifiers ------------------------------------------------------------

export const AgentIdSchema = z.string().regex(/^ag_[0-9a-f]{32}$/, "expected an ag_ agent ID");
export const PhonebookRequestIdSchema = z
  .string()
  .regex(/^rq_[0-9a-f]{32}$/, "expected an rq_ request ID");
export const EventIdSchema = z.string().regex(/^ev_[0-9a-f]{32}$/);
/** Chosen once per intended ask by the model; reused verbatim on retries. */
export const IdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "idempotency_key: 8-64 chars of A-Z a-z 0-9 _ -");

// ---- text fields ------------------------------------------------------------

/** Plain text: no control characters except newline and tab. */
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const PLAIN_TEXT = /^[^\u0000-\u0008\u000b-\u001f\u007f]*$/u;

const plain = (field: string) =>
  z.string().regex(PLAIN_TEXT, `${field} must be plain text (no control characters)`);

export const AgentNameSchema = plain("name")
  .transform((s) => s.trim())
  .pipe(z.string().min(1, "name is required").max(EXCHANGE_LIMITS.nameMaxChars))
  .refine((s) => !/[\n\t]/.test(s), "name must be a single line");

export const AgentDescriptionSchema = plain("description")
  .transform((s) => s.trim())
  .refine(
    (s) => utf8Bytes(s) <= EXCHANGE_LIMITS.descriptionMaxBytes,
    "description is limited to 512 UTF-8 bytes",
  );

export const QuestionTextSchema = plain("question")
  .refine((s) => s.trim().length > 0, "question is required")
  .refine(
    (s) => utf8Bytes(s) <= EXCHANGE_LIMITS.questionMaxBytes,
    "question is limited to 4 KiB (UTF-8)",
  );

export const ReplyTextSchema = plain("text")
  .refine((s) => s.trim().length > 0, "text is required")
  .refine((s) => utf8Bytes(s) <= EXCHANGE_LIMITS.replyMaxBytes, "text is limited to 8 KiB (UTF-8)");

// ---- topics -------------------------------------------------------------------

/**
 * Topic tags are normalized by trimming and lower-casing; the result must use
 * the conservative alphabet a-z 0-9 with single '-' or '.' separators.
 */
export const TOPIC_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

export function normalizeTopic(raw: string): string {
  return raw.trim().toLowerCase();
}

export const TopicListSchema = z
  .array(z.string().max(EXCHANGE_LIMITS.topicMaxChars * 2))
  .transform((list) => [...new Set(list.map(normalizeTopic))].sort())
  .pipe(
    z
      .array(
        z
          .string()
          .max(EXCHANGE_LIMITS.topicMaxChars, "each topic is limited to 48 characters")
          .regex(TOPIC_RE, "topics use a-z 0-9 with single - or . separators"),
      )
      .min(EXCHANGE_LIMITS.topicsMin, "at least one topic is required")
      .max(EXCHANGE_LIMITS.topicsMax, "at most 8 topics"),
  );

export const ApprovedSendersSchema = z
  .array(ParticipantIdSchema)
  .max(EXCHANGE_LIMITS.approvedSendersMax, "at most 32 approved senders")
  .transform((ids) => [...new Set(ids)].sort());

// ---- views returned to clients --------------------------------------------------

export const RequestStateSchema = z.enum([
  "pending",
  "answered",
  "declined",
  "expired",
  "failed",
  "no_match",
]);
export type RequestState = z.infer<typeof RequestStateSchema>;
export const TERMINAL_STATES: readonly RequestState[] = [
  "answered",
  "declined",
  "expired",
  "failed",
  "no_match",
];

export const RegistrationViewSchema = z
  .object({
    agent_id: AgentIdSchema,
    session_id: SessionIdSchema,
    name: z.string(),
    description: z.string(),
    topics: z.array(z.string()),
    approved_sender_count: z.number().int(),
    approved_participant_ids: z.array(ParticipantIdSchema),
    receiving: z.boolean(),
    published: z.boolean(),
    eligible: z.boolean(),
    busy: z.boolean(),
    action_needed: z.string().nullable(),
    /** Only sent to sessions that declared grants.v1 (older connectors parse strictly). */
    grants: z
      .object({ self: z.boolean(), emails: z.array(z.string()) })
      .strict()
      .optional(),
  })
  .strict();
export type RegistrationView = z.infer<typeof RegistrationViewSchema>;

export const RequestViewSchema = z
  .object({
    phonebook_request_id: PhonebookRequestIdSchema,
    role: z.enum(["requester", "recipient"]),
    state: RequestStateSchema,
    agent_id: AgentIdSchema.nullable(),
    created_at: z.number().int(),
    expires_at: z.number().int(),
    terminal_at: z.number().int().nullable(),
    terminal_reason: z.string().nullable(),
    result: z
      .object({ outcome: z.enum(["answer", "decline"]), text: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export type RequestView = z.infer<typeof RequestViewSchema>;

export const SessionViewSchema = z
  .object({
    session_id: SessionIdSchema,
    participant_id: ParticipantIdSchema,
    exchange_capable: z.boolean(),
    transport: z.literal("connected"),
    channel: z.enum(["none", "pending", "verified", "expired", "failed"]),
    channel_ready: z.boolean(),
    lease_expires_at: z.number().int(),
    registration: RegistrationViewSchema.nullable(),
    outgoing_pending_request_id: PhonebookRequestIdSchema.nullable(),
    assigned_pending_request_id: PhonebookRequestIdSchema.nullable(),
  })
  .strict();
export type SessionView = z.infer<typeof SessionViewSchema>;

// ---- connector → server operations -------------------------------------------------

const v = z.literal(1);

export const RegisterOpSchema = z
  .object({
    v,
    type: z.literal("register"),
    request_id: RequestIdSchema,
    name: z.string().max(1024),
    description: z.string().max(4096),
    topics: z.array(z.string().max(256)).max(64),
    /** Legacy/admin path: explicit participant IDs. */
    allowed_participant_ids: z.array(z.string().max(64)).max(256).optional(),
    /** Phase 4 path: "my other sessions" and/or exact verified emails. Not combinable with the above. */
    approved_senders: z
      .object({
        self: z.boolean().optional(),
        emails: z.array(z.string().max(320)).max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SetReceivingOpSchema = z
  .object({
    v,
    type: z.literal("set_receiving"),
    request_id: RequestIdSchema,
    receiving: z.boolean(),
  })
  .strict();

export const StatusOpSchema = z
  .object({ v, type: z.literal("status"), request_id: RequestIdSchema })
  .strict();

export const AskOpSchema = z
  .object({
    v,
    type: z.literal("ask"),
    request_id: RequestIdSchema,
    idempotency_key: z.string().max(128),
    question: z.string().max(16 * 1024),
    topics: z.array(z.string().max(256)).max(64).optional(),
    target_agent_id: z.string().max(64).optional(),
  })
  .strict();

export const ReplyOpSchema = z
  .object({
    v,
    type: z.literal("reply"),
    request_id: RequestIdSchema,
    phonebook_request_id: z.string().max(64),
    outcome: z.enum(["answer", "decline"]),
    text: z.string().max(16 * 1024),
  })
  .strict();

export const GetRequestOpSchema = z
  .object({
    v,
    type: z.literal("get_request"),
    request_id: RequestIdSchema,
    phonebook_request_id: z.string().max(64),
  })
  .strict();

// ---- server → connector results and events -------------------------------------------

export const RegistrationResultSchema = z
  .object({
    v,
    type: z.literal("registration_result"),
    request_id: RequestIdSchema,
    registration: RegistrationViewSchema,
  })
  .strict();

export const StatusResultSchema = z
  .object({
    v,
    type: z.literal("status_result"),
    request_id: RequestIdSchema,
    status: SessionViewSchema,
  })
  .strict();

export const RequestResultSchema = z
  .object({
    v,
    type: z.literal("request_result"),
    request_id: RequestIdSchema,
    /** True when an existing record was returned (idempotent retry / duplicate reply). */
    existing: z.boolean(),
    request: RequestViewSchema,
  })
  .strict();

const eventBase = {
  v,
  event_id: EventIdSchema,
  phonebook_request_id: PhonebookRequestIdSchema,
  /** The session this event is bound to (recipient for questions, original requester for results). */
  session_id: SessionIdSchema,
  agent_id: AgentIdSchema,
};

export const QuestionEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("question"),
    sender_participant_id: ParticipantIdSchema,
    /**
     * grants.v1 recipients only: "self" when the sender is the recipient's own
     * account, or the sender's verified email when the recipient approved
     * exactly that address. Never reveals an email the recipient did not enter.
     */
    sender_label: z.string().max(320).optional(),
    question: z.string(),
    topics: z.array(z.string()),
    expires_at: z.number().int(),
  })
  .strict();

export const AnswerEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("answer"),
    text: z.string(),
    completed_at: z.number().int(),
  })
  .strict();

export const DeclineEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("decline"),
    text: z.string(),
    completed_at: z.number().int(),
  })
  .strict();

export const RequestStatusEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("request_status"),
    state: z.enum(["expired", "failed"]),
    reason: z.string().max(64),
    completed_at: z.number().int(),
  })
  .strict();

export type QuestionEvent = z.infer<typeof QuestionEventSchema>;
export type AnswerEvent = z.infer<typeof AnswerEventSchema>;
export type DeclineEvent = z.infer<typeof DeclineEventSchema>;
export type RequestStatusEvent = z.infer<typeof RequestStatusEventSchema>;

/** Exact email input: trimmed and lower-cased (as the identity provider stores it); no alias folding. */
export const ApprovedEmailSchema = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(
    z
      .string()
      .max(254)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "not an email address"),
  );
