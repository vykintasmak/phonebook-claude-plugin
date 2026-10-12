import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { API_PATHS, CANONICAL_ORIGIN, HealthResponseSchema } from "@agent-phonebook/protocol";
import { checkPrivateFile, loadConfig } from "./config.js";
import { SERVER_NAME } from "./server.js";
import { CONNECTOR_VERSION } from "./versions.js";

/**
 * Project-local setup for the `phonebook` MCP entry.
 *
 * - Reads Claude's configuration READ-ONLY, and only the selected project's
 *   local-scope entry (never printed beyond that entry).
 * - Writes only through Claude's own CLI (`claude mcp add-json --scope local`,
 *   `claude mcp remove --scope local`) with argument arrays, never by editing
 *   Claude's files. Never uses `claude mcp get`, which starts the server.
 * - Keeps a private ownership manifest so uninstall never removes an entry the
 *   user changed after installing.
 */

export const TESTED_CLAUDE_VERSIONS = ["2.1.286", "2.1.288"];
export const SUPPORTED_NODE_MAJOR = 24;

export interface McpEntry {
  type?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SetupEnv {
  env: NodeJS.ProcessEnv;
  claudeBin: string;
  stateDir: string;
  nodePath: string;
  connectorEntry: string;
}

export function defaultSetupEnv(
  connectorEntry: string,
  env: NodeJS.ProcessEnv = process.env,
): SetupEnv {
  return {
    env,
    claudeBin: env.PHONEBOOK_CLAUDE_BIN ?? "claude",
    stateDir: env.PHONEBOOK_STATE_DIR ?? join(homedir(), ".config", "agent-phonebook"),
    nodePath: process.execPath,
    connectorEntry,
  };
}

export class SetupError extends Error {}

// ---- Claude configuration (read-only) ------------------------------------------------

function claudeConfigFile(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR
    ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(homedir(), ".claude.json");
}

interface ClaudeView {
  local: McpEntry | null;
  user: boolean;
  projectFile: boolean;
}

/** Reads only the `phonebook` entries that matter for this project. */
export function readClaudeView(projectReal: string, env: NodeJS.ProcessEnv): ClaudeView {
  let data: {
    mcpServers?: Record<string, unknown>;
    projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
  } = {};
  const file = claudeConfigFile(env);
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new SetupError(
        `Could not parse Claude's configuration (${file}); not changing anything.`,
      );
    }
  }
  const local =
    (data.projects?.[projectReal]?.mcpServers?.[SERVER_NAME] as McpEntry | undefined) ?? null;
  let projectFile = false;
  const mcpJson = join(projectReal, ".mcp.json");
  if (existsSync(mcpJson)) {
    try {
      projectFile =
        SERVER_NAME in
        ((JSON.parse(readFileSync(mcpJson, "utf8")) as { mcpServers?: object }).mcpServers ?? {});
    } catch {
      projectFile = false;
    }
  }
  return { local, user: !!data.mcpServers && SERVER_NAME in data.mcpServers, projectFile };
}

export function fingerprint(entry: McpEntry): string {
  const canonical = JSON.stringify({
    command: entry.command,
    args: entry.args,
    env: Object.fromEntries(Object.entries(entry.env ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Entries written by this package or earlier Phonebook setup scripts. */
export function looksLikePhonebook(entry: McpEntry): boolean {
  const script = entry.args[0] ?? "";
  return (
    /(^|\/)node(\.exe)?$/.test(entry.command) &&
    (/\/phonebook\.mjs$/.test(script) || /\/connector\/dist\/cli\.js$/.test(script)) &&
    ["serve", "diagnose"].includes(entry.args[1] ?? "")
  );
}

// ---- ownership manifest ----------------------------------------------------------------

interface Manifest {
  version: 1;
  installs: Record<
    string,
    { fingerprint: string; connector_version: string; installed_at: string }
  >;
}

function manifestFile(s: SetupEnv): string {
  return join(s.stateDir, "installs.json");
}

function readManifest(s: SetupEnv): Manifest {
  try {
    const m = JSON.parse(readFileSync(manifestFile(s), "utf8")) as Manifest;
    if (m.version === 1 && m.installs) return m;
  } catch {
    // missing or unreadable: treat as empty
  }
  return { version: 1, installs: {} };
}

function writeManifest(s: SetupEnv, m: Manifest): void {
  mkdirSync(s.stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${manifestFile(s)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, manifestFile(s));
}

// ---- checks -------------------------------------------------------------------------------

export type CheckLevel = "ok" | "warn" | "fail" | "info";
export interface Check {
  level: CheckLevel;
  name: string;
  detail: string;
}

function insideGitRepo(path: string): string | null {
  let dir = dirname(path);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveProject(project: string | undefined): string {
  if (!project) throw new SetupError("Pass --project <absolute path to the project>.");
  if (!isAbsolute(project)) throw new SetupError("--project must be an absolute path.");
  if (!existsSync(project) || !statSync(project).isDirectory()) {
    throw new SetupError(`Project directory not found: ${project}`);
  }
  return realpathSync(project);
}

export function checkRuntime(s: SetupEnv): Check[] {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    major === SUPPORTED_NODE_MAJOR
      ? { level: "ok", name: "node", detail: `${process.version} (${s.nodePath})` }
      : major < SUPPORTED_NODE_MAJOR
        ? {
            level: "fail",
            name: "node",
            detail: `${process.version}; Node ${SUPPORTED_NODE_MAJOR} is required (with nvm: nvm install ${SUPPORTED_NODE_MAJOR} && nvm use ${SUPPORTED_NODE_MAJOR}; or install it from https://nodejs.org)`,
          }
        : {
            level: "warn",
            name: "node",
            detail: `${process.version}; tested with Node ${SUPPORTED_NODE_MAJOR} only`,
          },
  );
  const claude = spawnSync(s.claudeBin, ["--version"], {
    encoding: "utf8",
    env: s.env,
    timeout: 15_000,
  });
  if (claude.status !== 0) {
    checks.push({
      level: "fail",
      name: "claude",
      detail: `Claude Code CLI not found (${s.claudeBin}); install it first`,
    });
  } else {
    const v = /(\d+\.\d+\.\d+)/.exec(claude.stdout)?.[1] ?? claude.stdout.trim();
    checks.push({
      level: "ok",
      name: "claude",
      detail: TESTED_CLAUDE_VERSIONS.includes(v)
        ? `${v} (tested)`
        : `${v} (not yet tested with Phonebook; not necessarily a problem)`,
    });
  }
  checks.push({
    level: "ok",
    name: "connector",
    detail: `${CONNECTOR_VERSION} (${s.connectorEntry})`,
  });
  return checks;
}

export function checkParticipantConfig(configPath: string | undefined): {
  checks: Check[];
  configReal: string | null;
} {
  if (!configPath)
    return {
      checks: [
        {
          level: "fail",
          name: "config",
          detail: "Pass --config <private participant config file>.",
        },
      ],
      configReal: null,
    };
  if (!isAbsolute(configPath))
    return {
      checks: [{ level: "fail", name: "config", detail: "--config must be an absolute path." }],
      configReal: null,
    };
  if (!existsSync(configPath))
    return {
      checks: [{ level: "fail", name: "config", detail: `not found: ${configPath}` }],
      configReal: null,
    };
  const real = realpathSync(configPath);
  const checks: Check[] = [];
  const repo = insideGitRepo(real);
  if (repo)
    checks.push({
      level: "fail",
      name: "config",
      detail: `${real} is inside a Git repository (${repo}); keep it outside any repository`,
    });
  const perms = checkPrivateFile(real);
  if (perms.length) checks.push({ level: "fail", name: "config", detail: perms.join(" ") });
  try {
    const cfg = loadConfig(real);
    checks.push({
      level: "ok",
      name: "config",
      detail: `${real}: ${cfg.mode} backend ${cfg.backendOrigin}; credential present (not shown)`,
    });
    if (cfg.mode === "hosted" && cfg.backendOrigin !== CANONICAL_ORIGIN) {
      checks.push({
        level: "warn",
        name: "config",
        detail: `backend is not the canonical ${CANONICAL_ORIGIN} (left unchanged)`,
      });
    }
  } catch (err) {
    checks.push({ level: "fail", name: "config", detail: (err as Error).message });
  }
  return { checks, configReal: real };
}

export function desiredEntry(s: SetupEnv, configReal: string): McpEntry {
  return {
    type: "stdio",
    command: s.nodePath,
    args: [s.connectorEntry, "serve"],
    env: { PHONEBOOK_CONFIG: configReal },
  };
}

function shellQuote(v: string): string {
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

export function launchCommand(projectReal: string): string {
  return `cd ${shellQuote(projectReal)} && MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels server:${SERVER_NAME}`;
}

export function runClaude(s: SetupEnv, cwd: string, args: string[]): void {
  const res = spawnSync(s.claudeBin, args, { cwd, encoding: "utf8", env: s.env, timeout: 30_000 });
  if (res.status !== 0) {
    throw new SetupError(
      `claude ${args.slice(0, 3).join(" ")} failed: ${(res.stderr || res.stdout || "").trim().slice(0, 300)}`,
    );
  }
}

const entryCommandPreview = (projectReal: string, e: McpEntry) =>
  `(cd ${shellQuote(projectReal)} && claude mcp add-json --scope local ${SERVER_NAME} ${shellQuote(JSON.stringify(e))})`;

// ---- install ---------------------------------------------------------------------------------

export interface PlanResult {
  ok: boolean;
  action: "add" | "replace" | "noop" | "remove" | "none" | "blocked";
  checks: Check[];
  preview: string[];
  applied: boolean;
  messages: string[];
}

export function install(
  s: SetupEnv,
  opts: { project?: string; config?: string; apply: boolean; replace: boolean },
): PlanResult {
  const checks: Check[] = [...checkRuntime(s)];
  const projectReal = resolveProject(opts.project);
  checks.push({ level: "ok", name: "project", detail: projectReal });
  const { checks: cfgChecks, configReal } = checkParticipantConfig(opts.config);
  checks.push(...cfgChecks);
  const failed = checks.some((c) => c.level === "fail");
  const result: PlanResult = {
    ok: false,
    action: "blocked",
    checks,
    preview: [],
    applied: false,
    messages: [],
  };
  if (failed || !configReal) {
    result.messages.push("Nothing changed: fix the failed checks above first.");
    return result;
  }

  const view = readClaudeView(projectReal, s.env);
  if (view.projectFile) {
    checks.push({
      level: "warn",
      name: "claude",
      detail:
        "this project's shared .mcp.json also defines 'phonebook'; Phonebook will not edit it",
    });
  }
  if (view.user) {
    checks.push({
      level: "warn",
      name: "claude",
      detail:
        "a user-scope 'phonebook' entry exists; the local entry takes precedence in this project",
    });
  }
  const want = desiredEntry(s, configReal);
  const manifest = readManifest(s);

  if (view.local && fingerprint(view.local) === fingerprint(want)) {
    result.ok = true;
    result.action = "noop";
    result.messages.push(
      "Already installed for this project with exactly this configuration; nothing to do.",
    );
  } else if (view.local && !looksLikePhonebook(view.local)) {
    result.messages.push(
      "A different MCP server named 'phonebook' is already configured for this project (not a Phonebook connector). " +
        `Nothing changed. Remove it yourself first if you want to replace it: (cd ${shellQuote(projectReal)} && claude mcp remove --scope local ${SERVER_NAME})`,
    );
    return result;
  } else if (view.local && !opts.replace) {
    result.action = "blocked";
    result.preview.push(
      `(cd ${shellQuote(projectReal)} && claude mcp remove --scope local ${SERVER_NAME})`,
      entryCommandPreview(projectReal, want),
    );
    result.messages.push(
      "A Phonebook entry with different settings (older version, path or config) exists for this project. " +
        "Re-run with --replace to update it (shown above), or keep the current one.",
    );
    return result;
  } else {
    result.ok = true;
    result.action = view.local ? "replace" : "add";
    if (view.local)
      result.preview.push(
        `(cd ${shellQuote(projectReal)} && claude mcp remove --scope local ${SERVER_NAME})`,
      );
    result.preview.push(entryCommandPreview(projectReal, want));
  }

  if (opts.apply && (result.action === "add" || result.action === "replace")) {
    if (result.action === "replace")
      runClaude(s, projectReal, ["mcp", "remove", "--scope", "local", SERVER_NAME]);
    runClaude(s, projectReal, [
      "mcp",
      "add-json",
      "--scope",
      "local",
      SERVER_NAME,
      JSON.stringify(want),
    ]);
    const after = readClaudeView(projectReal, s.env).local;
    if (!after || fingerprint(after) !== fingerprint(want)) {
      throw new SetupError(
        "Claude reported success but the entry does not match what was written; please check `claude mcp list` in the project.",
      );
    }
    manifest.installs[projectReal] = {
      fingerprint: fingerprint(want),
      connector_version: CONNECTOR_VERSION,
      installed_at: new Date().toISOString(),
    };
    writeManifest(s, manifest);
    result.applied = true;
  } else if (result.action === "noop" && !manifest.installs[projectReal]) {
    // Record ownership of an identical entry so uninstall can recognize it later.
    if (opts.apply) {
      manifest.installs[projectReal] = {
        fingerprint: fingerprint(want),
        connector_version: CONNECTOR_VERSION,
        installed_at: new Date().toISOString(),
      };
      writeManifest(s, manifest);
    }
  }
  if (!opts.apply && (result.action === "add" || result.action === "replace")) {
    result.messages.push("Preview only. Re-run with --apply to make exactly this change.");
  }
  result.messages.push(
    "Installing does not verify a channel, register an agent, or make anyone available. " +
      "Start a NEW Claude session in the project (a running session will not pick this up):",
    `  ${launchCommand(projectReal)}`,
  );
  return result;
}

// ---- uninstall -------------------------------------------------------------------------------

export function uninstall(s: SetupEnv, opts: { project?: string; apply: boolean }): PlanResult {
  const projectReal = resolveProject(opts.project);
  const result: PlanResult = {
    ok: false,
    action: "none",
    checks: [{ level: "ok", name: "project", detail: projectReal }],
    preview: [],
    applied: false,
    messages: [],
  };
  const view = readClaudeView(projectReal, s.env);
  const manifest = readManifest(s);
  const owned = manifest.installs[projectReal];
  if (!view.local) {
    result.ok = true;
    result.messages.push("No local-scope 'phonebook' entry for this project; nothing to remove.");
    if (owned && opts.apply) {
      delete manifest.installs[projectReal];
      writeManifest(s, manifest);
    }
    return result;
  }
  const fp = fingerprint(view.local);
  if (owned && owned.fingerprint !== fp) {
    result.action = "blocked";
    result.messages.push(
      "The 'phonebook' entry changed after Phonebook installed it, so it was left untouched. " +
        `Remove it yourself if intended: (cd ${shellQuote(projectReal)} && claude mcp remove --scope local ${SERVER_NAME})`,
    );
    return result;
  }
  if (!owned && !looksLikePhonebook(view.local)) {
    result.action = "blocked";
    result.messages.push(
      "The 'phonebook' entry here is not a Phonebook connector entry; left untouched.",
    );
    return result;
  }
  result.ok = true;
  result.action = "remove";
  result.preview.push(
    `(cd ${shellQuote(projectReal)} && claude mcp remove --scope local ${SERVER_NAME})`,
  );
  if (opts.apply) {
    runClaude(s, projectReal, ["mcp", "remove", "--scope", "local", SERVER_NAME]);
    if (readClaudeView(projectReal, s.env).local)
      throw new SetupError("Claude reported success but the entry is still present.");
    delete manifest.installs[projectReal];
    writeManifest(s, manifest);
    result.applied = true;
  } else {
    result.messages.push("Preview only. Re-run with --apply to remove exactly this entry.");
  }
  result.messages.push(
    "Removing the entry does not revoke the participant credential, delete the private config, or stop a Claude session " +
      "that is already running; close that session for an immediate local shutdown.",
  );
  return result;
}

// ---- doctor ------------------------------------------------------------------------------------

export async function doctor(
  s: SetupEnv,
  opts: { project?: string; config?: string; offline: boolean },
): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [...checkRuntime(s)];
  let projectReal: string | null = null;
  try {
    projectReal = resolveProject(opts.project);
    checks.push({ level: "ok", name: "project", detail: projectReal });
  } catch (err) {
    checks.push({ level: "fail", name: "project", detail: (err as Error).message });
  }
  const { checks: cfgChecks, configReal } = checkParticipantConfig(opts.config);
  checks.push(...cfgChecks);

  if (projectReal) {
    const view = readClaudeView(projectReal, s.env);
    if (!view.local) {
      checks.push({
        level: "fail",
        name: "mcp entry",
        detail:
          "no local-scope 'phonebook' entry for this project; run `phonebook install … --apply`",
      });
    } else if (configReal && fingerprint(view.local) === fingerprint(desiredEntry(s, configReal))) {
      checks.push({
        level: "ok",
        name: "mcp entry",
        detail: "local-scope 'phonebook' entry matches this installation and config",
      });
    } else if (looksLikePhonebook(view.local)) {
      checks.push({
        level: "warn",
        name: "mcp entry",
        detail:
          "a Phonebook entry exists but points at a different installation or config; `phonebook install … --replace --apply` updates it",
      });
    } else {
      checks.push({
        level: "fail",
        name: "mcp entry",
        detail: "a non-Phonebook MCP server named 'phonebook' is configured for this project",
      });
    }
    if (view.projectFile)
      checks.push({
        level: "warn",
        name: "mcp entry",
        detail: "shared .mcp.json also defines 'phonebook'",
      });
  }

  if (!opts.offline && configReal) {
    try {
      const cfg = loadConfig(configReal);
      const res = await fetch(`${cfg.backendOrigin}${API_PATHS.health}`, {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      const body = HealthResponseSchema.safeParse(await res.json().catch(() => null));
      checks.push(
        res.ok && body.success
          ? {
              level: "ok",
              name: "backend",
              detail: `${cfg.backendOrigin} reachable (credential-free health check, ${body.data.phase})`,
            }
          : {
              level: "fail",
              name: "backend",
              detail: `${cfg.backendOrigin}/api/health returned HTTP ${res.status}`,
            },
      );
    } catch (err) {
      checks.push({
        level: "fail",
        name: "backend",
        detail: `health check failed: ${(err as Error).message}`,
      });
    }
  } else {
    checks.push({ level: "info", name: "backend", detail: "not checked (--offline)" });
  }
  checks.push(
    {
      level: "info",
      name: "authentication",
      detail: "not tested here (doctor opens no authenticated session)",
    },
    {
      level: "info",
      name: "channel",
      detail:
        'current-session readiness is not observable from here; inside Claude ask: "Check my phonebook status" (set_availability action status)',
    },
  );
  if (projectReal)
    checks.push({ level: "info", name: "launch", detail: launchCommand(projectReal) });
  return { ok: !checks.some((c) => c.level === "fail"), checks };
}
