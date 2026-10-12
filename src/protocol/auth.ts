import { z } from "zod";
import { InstallationTokenSchema } from "./credentials.js";
import { ParticipantIdSchema } from "./ids.js";

/**
 * Phase 4 self-service onboarding contracts. WorkOS authenticates the human;
 * Phonebook issues a separately revocable installation credential.
 */
export const AUTH_PATHS = {
  config: "/api/auth/config",
  installations: "/api/auth/installations",
  installationSelf: "/api/auth/installations/self",
  installationSelfRevoke: "/api/auth/installations/self/revoke",
  devices: "/api/auth/devices",
  webhook: "/api/auth/workos/events",
} as const;
export const DEVICE_REVOKE_PATH_RE = /^\/api\/auth\/devices\/(i_[0-9a-f]{32})\/revoke$/;

export const AUTH_LIMITS = {
  /** Active installation credentials per account. */
  installationsPerAccount: 10,
  /** Enrollment requests per account per hour (each one replaces at most one installation). */
  enrollmentsPerAccountPerHour: 20,
  /** Pre-authentication auth-endpoint requests per client IP per minute. */
  authRequestsPerIpPerMinute: 30,
  enrollmentBodyBytes: 2 * 1024,
  webhookBodyBytes: 64 * 1024,
  webhookToleranceMs: 5 * 60_000,
  installationLabelMaxChars: 40,
  /** Default absolute lifetime of a self-service installation credential (server-configurable). */
  defaultInstallationTtlDays: 90,
} as const;

export const InstallationIdSchema = z.string().regex(/^inst_[0-9a-f]{32}$/);
export const CredentialIdSchema = z.string().regex(/^i_[0-9a-f]{32}$/);

export const AuthConfigResponseSchema = z
  .object({
    self_service_enabled: z.boolean(),
    workos: z
      .object({
        client_id: z.string(),
        authkit_origin: z.string(),
        device_authorization_endpoint: z.string(),
        token_endpoint: z.string(),
      })
      .strict()
      .nullable(),
    protocol_version: z.literal(1),
    capabilities: z.array(z.string()),
  })
  .strict();
export type AuthConfigResponse = z.infer<typeof AuthConfigResponseSchema>;

export const EnrollRequestSchema = z
  .object({
    installation_id: InstallationIdSchema,
    label: z
      .string()
      .max(AUTH_LIMITS.installationLabelMaxChars)
      .regex(/^[A-Za-z0-9 ._-]*$/, "label: letters, digits, space . _ -")
      .optional(),
    connector_version: z.string().max(32).optional(),
  })
  .strict();

export const EnrollResponseSchema = z
  .object({
    participant_id: ParticipantIdSchema,
    credential_id: z.string(),
    token: InstallationTokenSchema,
    expires_at: z.number().int(),
    email: z.string(),
    replaced_credential: z.boolean(),
    new_account: z.boolean(),
  })
  .strict();
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;

export const InstallationSelfSchema = z
  .object({
    participant_id: ParticipantIdSchema,
    credential_id: z.string(),
    expires_at: z.number().int(),
    email: z.string().nullable(),
  })
  .strict();

export const DeviceSchema = z
  .object({
    credential_id: z.string(),
    label: z.string().nullable(),
    created_at: z.number().int(),
    expires_at: z.number().int(),
    revoked_at: z.number().int().nullable(),
  })
  .strict();
export type Device = z.infer<typeof DeviceSchema>;
export const DevicesResponseSchema = z.object({ devices: z.array(DeviceSchema) }).strict();
