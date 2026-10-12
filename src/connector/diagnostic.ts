import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Developer-only channel delivery diagnostic.
 *
 * One fresh run per connector process: a random run ID and an unpredictable
 * challenge nonce. Only a matching call to the confirmation tool — made by
 * Claude after receiving the channel event — can mark the run verified. Writing
 * the notification, connecting, or listing tools never does.
 */
export const CONFIRM_TOOL_NAME = "phonebook_dev_confirm_channel";
export const CHANNEL_EVENT_TYPE = "channel_challenge";

export const ConfirmInputSchema = z
  .object({
    run_id: z.string().min(1).max(64),
    challenge: z.string().min(1).max(128),
  })
  .strict();
export type ConfirmInput = z.infer<typeof ConfirmInputSchema>;

export type Outcome = "pending" | "verified" | "expired" | "failed" | "unverified";

export type ConfirmResult =
  | { kind: "verified" }
  | { kind: "duplicate" }
  | { kind: "rejected"; reason: "unknown_run" | "wrong_challenge" | "expired" | "inactive" };

export interface DiagnosticEvidence {
  run_id: string;
  outcome: Outcome;
  started_at: string;
  expires_at: string;
  challenge_emissions: string[];
  confirmed_at: string | null;
  ended_at: string | null;
  rejected_confirmations: number;
  duplicate_confirmations: number;
}

export interface DiagnosticOptions {
  ttlMs: number;
  maxInvalidAttempts?: number;
  now?: () => number;
  random?: (bytes: number) => Buffer;
  runId?: string;
}

export class ChannelDiagnostic {
  readonly runId: string;
  private readonly nonce: string;
  private readonly now: () => number;
  private readonly startedAt: number;
  readonly expiresAt: number;
  private readonly maxInvalid: number;
  private state: Outcome = "pending";
  private emissions: number[] = [];
  private confirmedAt: number | null = null;
  private endedAt: number | null = null;
  private rejected = 0;
  private duplicates = 0;

  constructor(opts: DiagnosticOptions) {
    this.now = opts.now ?? Date.now;
    const random = opts.random ?? randomBytes;
    this.runId = opts.runId ?? randomUUID();
    this.nonce = random(18).toString("base64url");
    this.startedAt = this.now();
    this.expiresAt = this.startedAt + opts.ttlMs;
    this.maxInvalid = opts.maxInvalidAttempts ?? 5;
  }

  get outcome(): Outcome {
    return this.state;
  }

  /** The synthetic channel event. Content is fixed; the nonce travels in meta. */
  challengeEvent(): { content: string; meta: Record<string, string> } {
    return {
      content:
        "Phonebook channel diagnostic (synthetic test event). " +
        `Call ${CONFIRM_TOOL_NAME} once with the run_id and challenge attributes of this tag, ` +
        "copied exactly. Take no other action.",
      meta: { event: CHANNEL_EVENT_TYPE, run_id: this.runId, challenge: this.nonce },
    };
  }

  recordEmission(): void {
    this.emissions.push(this.now());
  }

  /** Marks the run expired when its deadline has passed. Returns true on transition. */
  expireIfDue(): boolean {
    if (this.state === "pending" && this.now() >= this.expiresAt) {
      this.state = "expired";
      this.endedAt = this.now();
      return true;
    }
    return false;
  }

  confirm(input: ConfirmInput): ConfirmResult {
    const runMatches = input.run_id === this.runId;
    const nonceMatches = runMatches && safeEqual(input.challenge, this.nonce);

    if (this.state === "verified") {
      if (nonceMatches) {
        this.duplicates++;
        return { kind: "duplicate" };
      }
      this.rejected++;
      return { kind: "rejected", reason: runMatches ? "wrong_challenge" : "unknown_run" };
    }
    this.expireIfDue();
    if (this.state !== "pending") {
      this.rejected++;
      return { kind: "rejected", reason: this.state === "expired" ? "expired" : "inactive" };
    }
    if (!nonceMatches) {
      this.rejected++;
      if (this.rejected >= this.maxInvalid) {
        this.state = "failed";
        this.endedAt = this.now();
      }
      return { kind: "rejected", reason: runMatches ? "wrong_challenge" : "unknown_run" };
    }
    this.state = "verified";
    this.confirmedAt = this.now();
    return { kind: "verified" };
  }

  /** Called on shutdown: an unconfirmed run ends unverified, never verified. */
  finish(): void {
    if (this.state === "pending") {
      this.expireIfDue();
      if (this.state === "pending") this.state = "unverified";
    }
    this.endedAt ??= this.now();
  }

  /** Minimal evidence for the local receipt. Never includes the nonce. */
  evidence(): DiagnosticEvidence {
    const iso = (t: number) => new Date(t).toISOString();
    return {
      run_id: this.runId,
      outcome: this.state,
      started_at: iso(this.startedAt),
      expires_at: iso(this.expiresAt),
      challenge_emissions: this.emissions.map(iso),
      confirmed_at: this.confirmedAt === null ? null : iso(this.confirmedAt),
      ended_at: this.endedAt === null ? null : iso(this.endedAt),
      rejected_confirmations: this.rejected,
      duplicate_confirmations: this.duplicates,
    };
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
