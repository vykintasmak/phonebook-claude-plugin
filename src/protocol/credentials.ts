import { z } from "zod";
import { ParticipantIdSchema } from "./ids.js";

/**
 * Opaque bearer credentials. The secret part is 32 random bytes (base64url).
 * Participant and admin tokens use different prefixes and are never
 * interchangeable. Servers store only a SHA-256 digest of participant tokens.
 */
export const PARTICIPANT_TOKEN_RE = /^pbp_(p_[0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;
export const ADMIN_TOKEN_RE = /^pba_[A-Za-z0-9_-]{43}$/;

export const ParticipantTokenSchema = z.string().regex(PARTICIPANT_TOKEN_RE);
export const AdminTokenSchema = z.string().regex(ADMIN_TOKEN_RE);

/** Phase 4: per-installation credential `pbi_<credential_id>.<secret>` (self-service). */
export const INSTALLATION_TOKEN_RE = /^pbi_(i_[0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;
export const InstallationTokenSchema = z.string().regex(INSTALLATION_TOKEN_RE);

export type ParsedCredential =
  { kind: "participant"; participantId: string } | { kind: "installation"; credentialId: string };

/** Classifies a bearer token by format only (authority comes from the server check). */
export function parseCredential(token: string): ParsedCredential | null {
  const p = PARTICIPANT_TOKEN_RE.exec(token);
  if (p?.[1]) return { kind: "participant", participantId: p[1] };
  const i = INSTALLATION_TOKEN_RE.exec(token);
  if (i?.[1]) return { kind: "installation", credentialId: i[1] };
  return null;
}

/** Extracts the participant ID embedded in a well-formed participant token. */
export function participantIdFromToken(token: string): string | null {
  const m = PARTICIPANT_TOKEN_RE.exec(token);
  return m ? (m[1] ?? null) : null;
}

/** `Authorization: Bearer <token>` with exactly one space and no extra content. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(header);
  return m ? (m[1] ?? null) : null;
}

export const LabelSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, {
  message: "label: 1-32 chars, lowercase letters, digits and '-'",
});

export { ParticipantIdSchema };
