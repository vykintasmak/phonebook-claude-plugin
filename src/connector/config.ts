import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkServiceOrigin } from "@agent-phonebook/protocol";
import { z } from "zod";

/**
 * Normal-mode connector configuration: one private file per participant and
 * environment, outside any repository (default
 * ~/.config/agent-phonebook/config.json), mode 0600. It holds the explicit
 * backend origin and that participant's credential. MCP configs reference
 * only its path (PHONEBOOK_CONFIG), never the credential.
 */
export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "agent-phonebook", "config.json");

export const ConnectorConfigSchema = z
  .object({
    backendUrl: z.string(),
    /**
     * Either an owner-issued participant credential (pbp_, pilot) or a
     * self-service installation credential (pbi_, written by `phonebook setup`).
     * Absent after `phonebook logout`.
     */
    credential: z
      .string()
      .regex(
        /^pb[pi]_[A-Za-z0-9_.-]+$/,
        "credential must be a pbp_ participant or pbi_ installation token",
      )
      .optional(),
    // Non-secret metadata written by `phonebook setup` (ignored by serve).
    account: z.object({ participant_id: z.string(), email: z.string() }).strict().optional(),
    credential_id: z.string().optional(),
    installation_id: z.string().optional(),
    expires_at: z.number().optional(),
    issued_at: z.number().optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const check = checkServiceOrigin(cfg.backendUrl);
    if (!check.ok) ctx.addIssue({ code: "custom", path: ["backendUrl"], message: check.reason });
  });

export interface ResolvedConfig {
  backendOrigin: string;
  mode: "local" | "hosted";
  credential: string;
}

export class ConfigError extends Error {}

export function parseConfig(raw: unknown): ResolvedConfig {
  const result = ConnectorConfigSchema.safeParse(raw);
  if (!result.success) {
    // Never echo values: only paths and messages.
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`Invalid connector configuration: ${detail}`);
  }
  const check = checkServiceOrigin(result.data.backendUrl);
  if (!check.ok) throw new ConfigError(`Invalid connector configuration: ${check.reason}`);
  if (!result.data.credential) {
    throw new ConfigError(
      "This Phonebook account is signed out on this machine. Run: npx agent-phonebook setup",
    );
  }
  return {
    backendOrigin: check.origin,
    mode: check.loopback ? "local" : "hosted",
    credential: result.data.credential,
  };
}

/** Problems with a file that holds a secret (empty when acceptable). */
export function checkPrivateFile(path: string): string[] {
  let st;
  try {
    st = statSync(path);
  } catch {
    return [`${path} does not exist.`];
  }
  if (!st.isFile()) return [`${path} is not a regular file.`];
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    return [`${path} is readable by others; run: chmod 600 "${path}"`];
  }
  return [];
}

export function loadConfig(path: string): ResolvedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`Connector configuration not found at ${path}.`);
  }
  const problems = checkPrivateFile(path);
  if (problems.length) throw new ConfigError(problems.join(" "));
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`Connector configuration at ${path} is not valid JSON.`);
  }
  return parseConfig(raw);
}

/** Redacts anything token-shaped from a diagnostic string. */
export function redact(text: string): string {
  return text
    .replace(/pb[pai]_[A-Za-z0-9_.-]+/g, "pb*_[redacted]")
    .replace(/[A-Za-z0-9_-]{43}/g, "[redacted]");
}
