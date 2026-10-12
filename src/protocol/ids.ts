import { z } from "zod";

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{32}$`), `expected a ${prefix}_ identifier`);

export const ParticipantIdSchema = id("p");
export const SessionIdSchema = id("s");
export const ChallengeIdSchema = id("c");
/** Correlation ID chosen by the connector for request/outcome pairs. */
export const RequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** 32 random bytes, base64url without padding. */
export const NonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
