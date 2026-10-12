// Claude Code plugin mode. The plugin runs the same connector; what differs is
// how a session finds its account: a private project → account binding written
// by `phonebook setup-plugin`, instead of a standalone MCP entry that carries
// PHONEBOOK_CONFIG. Credentials stay in the existing private account files
// (never in the plugin's install or data directories, which updates/uninstall
// remove). Nothing here contacts the backend.
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { CANONICAL_ORIGIN, checkServiceOrigin } from "@agent-phonebook/protocol";
import type { DeviceLoginIO, DeviceStart } from "./device-login.js";
import {
  chooseAccount,
  credentialUsable,
  finishSignIn,
  listAccounts,
  locations,
  maskEmail,
  signInAndSave,
  startSignIn,
  withLock,
  writePrivateJson,
  type Account,
  type AccountFile,
  type Locations,
} from "./onboard.js";
import {
  checkRuntime,
  defaultSetupEnv,
  fingerprint,
  looksLikePhonebook,
  readClaudeView,
  runClaude,
  SetupError,
  uninstall,
  type McpEntry,
} from "./setup.js";
import { SERVER_NAME } from "./server.js";
import { TOOL_NAMES, TOOLS } from "./tools.js";
import { CONNECTOR_VERSION } from "./versions.js";

export const PLUGIN_NAME = "phonebook";
export const PLUGIN_MARKETPLACE = "phonebook";
export const PLUGIN_ID = `${PLUGIN_NAME}@${PLUGIN_MARKETPLACE}`;
/** Claude Code names plugin MCP tools mcp__plugin_<plugin>_<server>__<tool>. */
export const PLUGIN_TOOL_PREFIX = `mcp__plugin_${PLUGIN_NAME}_${SERVER_NAME}__`;

function shellQuote(v: string): string {
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** The one launch command that loads the plugin's channel in development mode. */
export function pluginLaunchCommand(projectReal: string): string {
  return `cd ${shellQuote(projectReal)} && MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels plugin:${PLUGIN_ID}`;
}

// ---- bindings ----------------------------------------------------------------------------

export interface Bindings {
  schema: 1;
  projects: Record<string, { participant_id: string; bound_at: string }>;
}

export function bindingsFile(loc: Locations): string {
  return join(loc.configDir, "plugin-bindings.json");
}

export function readBindings(loc: Locations): Bindings {
  const file = bindingsFile(loc);
  if (!existsSync(file)) return { schema: 1, projects: {} };
  try {
    const b = JSON.parse(readFileSync(file, "utf8")) as Bindings;
    if (b.schema !== 1 || typeof b.projects !== "object" || !b.projects) throw new Error("schema");
    return b;
  } catch {
    throw new Error(`Unreadable Phonebook plugin bindings (${file}); fix or remove it.`);
  }
}

/** Binds exactly one project; other projects' bindings are never changed. */
export function writeBinding(loc: Locations, projectReal: string, participantId: string): boolean {
  const b = readBindings(loc);
  const prev = b.projects[projectReal];
  if (prev?.participant_id === participantId) return false;
  b.projects[projectReal] = { participant_id: participantId, bound_at: new Date().toISOString() };
  writePrivateJson(bindingsFile(loc), b);
  return true;
}

export function removeBinding(loc: Locations, projectReal: string): boolean {
  const b = readBindings(loc);
  if (!b.projects[projectReal]) return false;
  delete b.projects[projectReal];
  writePrivateJson(bindingsFile(loc), b);
  return true;
}

// ---- project and state -------------------------------------------------------------------

/**
 * The Claude project this connector serves: the plugin passes ${CLAUDE_PROJECT_DIR};
 * an unexpanded placeholder or a missing value falls back to the working
 * directory Claude Code started the server in. Never the plugin directory.
 */
export function resolvePluginProject(env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  const candidates = [env.PHONEBOOK_PROJECT_DIR, env.CLAUDE_PROJECT_DIR, cwd];
  for (const c of candidates) {
    if (!c || c.includes("${")) continue;
    try {
      const real = realpathSync(c);
      if (statSync(real).isDirectory()) return real;
    } catch {
      // try the next candidate
    }
  }
  return realpathSync(cwd);
}

export type PluginState =
  | { kind: "ready"; project: string; configPath: string; email: string | null }
  | { kind: "not_set_up"; project: string }
  | { kind: "signed_out"; project: string; email: string | null }
  | { kind: "standalone_active"; project: string; scopes: string[] };

/** Derived on every start; never cached or written. */
export function pluginState(env: NodeJS.ProcessEnv, project: string): PluginState {
  // One active connector per session: an existing standalone Phonebook entry wins and the
  // plugin stays idle (both would otherwise run, since their commands differ).
  const view = readClaudeView(project, env);
  const scopes = [
    ...(view.local && looksLikePhonebook(view.local) ? ["local"] : []),
    ...(view.projectFile ? ["project (.mcp.json)"] : []),
    ...(view.user ? ["user"] : []),
  ];
  if (scopes.length) return { kind: "standalone_active", project, scopes };
  const loc = locations(env);
  const binding = readBindings(loc).projects[project];
  if (!binding) return { kind: "not_set_up", project };
  const configPath = join(loc.accountsDir, `${binding.participant_id}.json`);
  if (!existsSync(configPath)) return { kind: "signed_out", project, email: null };
  let data: AccountFile;
  try {
    data = JSON.parse(readFileSync(configPath, "utf8")) as AccountFile;
  } catch {
    return { kind: "signed_out", project, email: null };
  }
  const email = data.account?.email ?? null;
  if (!data.credential) return { kind: "signed_out", project, email };
  return { kind: "ready", project, configPath, email };
}

export function describePluginState(s: PluginState): string {
  const setup = "Run /phonebook:setup in this Claude session, then restart Claude with:";
  switch (s.kind) {
    case "ready":
      return `Phonebook is set up for ${s.project}.`;
    case "not_set_up":
      return `Phonebook is not set up for this project (${s.project}). ${setup}\n  ${pluginLaunchCommand(s.project)}`;
    case "signed_out":
      return `This project's Phonebook account is signed out on this machine. ${setup}\n  ${pluginLaunchCommand(s.project)}`;
    case "standalone_active":
      return (
        `A standalone Phonebook MCP entry is configured for this project (${s.scopes.join(", ")}), so the ` +
        "plugin's connector stays idle to avoid running two connectors. Use the standalone entry, or run " +
        "/phonebook:setup to migrate this project's local entry to the plugin."
      );
  }
}

// ---- idle server -------------------------------------------------------------------------

const text = (message: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError,
});

/**
 * Plugin connector that is not active for this project: same tool names, no backend,
 * no socket, no login. Status explains the state; every other call returns the same
 * actionable error. Restarting Claude after setup activates the real connector.
 */
export function createIdleSession(state: PluginState): Server {
  const reason = describePluginState(state);
  const server = new Server(
    { name: SERVER_NAME, version: CONNECTOR_VERSION },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions:
        "Phonebook plugin connector: NOT ACTIVE in this project, so no Phonebook events will arrive. " +
        "If the user asks about Phonebook, relay this and do not call Phonebook tools otherwise. " +
        reason,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as { action?: unknown };
    if (req.params.name === TOOL_NAMES.availability && args.action === "status") {
      return text(`Transport: not started (plugin idle).\n${reason}`);
    }
    return text(`Not sent: ${reason}`, true);
  });
  return server;
}

// ---- setup-plugin ------------------------------------------------------------------------

export interface PluginSetupOptions {
  project?: string;
  backend?: string;
  /** The user already initiated setup (e.g. /phonebook:setup): skip the y/N prompt. */
  yes: boolean;
  /** Explicit, separate consent to replace this project's standalone local entry. */
  migrate: boolean;
  /** Explicit consent to bind a not-yet-bound project to the one account already signed in. */
  useExisting?: boolean;
  noBrowser: boolean;
  switchAccount: boolean;
  account?: string;
  label?: string;
  /**
   * Two-step sign-in for callers that only see output after a command exits (the setup skill):
   * show the confirmation code and return 5 at once; `--finish` then waits for the browser.
   */
  noWait?: boolean;
  runningEntry: string;
  env?: NodeJS.ProcessEnv;
  io?: DeviceLoginIO;
  confirm?: (question: string) => Promise<boolean>;
  out?: (line: string) => void;
}

interface MigrationRecord {
  schema: 1;
  projects: Record<string, { entry: McpEntry; fingerprint: string; replaced_at: string }>;
}

export function migrationsFile(loc: Locations): string {
  return join(loc.configDir, "plugin-migrations.json");
}

function readMigrations(loc: Locations): MigrationRecord {
  const file = migrationsFile(loc);
  if (!existsSync(file)) return { schema: 1, projects: {} };
  return JSON.parse(readFileSync(file, "utf8")) as MigrationRecord;
}

/**
 * Plugin-mode setup: the same account choice, WorkOS email/device sign-in and private
 * credential storage as `setup`, but it binds the project instead of adding an MCP entry.
 * It never registers an agent or approves senders. A Phonebook-owned standalone local
 * entry is replaced only with `migrate`; user-scope and .mcp.json entries are reported,
 * never changed.
 */
/** A started, not yet completed sign-in for one project (0600; deleted on finish or expiry). */
interface PendingSignIn {
  schema: 1;
  project: string;
  origin: string;
  migrate: boolean;
  /** --switch-account: the user explicitly allowed this project to change account. */
  rebind: boolean;
  label?: string;
  device: DeviceStart;
}

function pendingFile(loc: Locations): string {
  return join(loc.configDir, "plugin-signin.json");
}

function readPending(loc: Locations): PendingSignIn | null {
  try {
    const p = JSON.parse(readFileSync(pendingFile(loc), "utf8")) as PendingSignIn;
    return p.schema === 1 ? p : null;
  } catch {
    return null;
  }
}

const clearPending = (loc: Locations) => rmSync(pendingFile(loc), { force: true });

export async function runPluginSetup(o: PluginSetupOptions): Promise<number> {
  const env = o.env ?? process.env;
  const out = o.out ?? ((l: string) => console.log(l));
  const loc = locations(env);
  const project = realpathSync(o.project ?? process.cwd());
  if (!statSync(project).isDirectory()) throw new SetupError(`Not a directory: ${project}`);
  const origin = checkServiceOrigin(o.backend ?? env.PHONEBOOK_BACKEND_URL ?? CANONICAL_ORIGIN);
  if (!origin.ok) throw new SetupError(`Backend URL: ${origin.reason}`);
  const s = defaultSetupEnv(o.runningEntry, env);
  const failed = checkRuntime(s).filter((c) => c.level === "fail");
  if (failed.length) throw new SetupError(failed.map((c) => `${c.name}: ${c.detail}`).join("; "));

  // Account: this project's existing binding first, unless the user chose otherwise.
  const bound = readBindings(loc).projects[project];
  let account: Account | null = null;
  if (bound && !o.account && !o.switchAccount) {
    account =
      listAccounts(loc).find(
        (a) =>
          a.data.account?.participant_id === bound.participant_id &&
          a.data.backendUrl === origin.origin,
      ) ?? null;
  }
  if (!bound && !account && !o.account && !o.switchAccount) {
    const existing = listAccounts(loc).filter((a) => a.data.backendUrl === origin.origin);
    if (existing.length > 1) {
      out(`Phonebook plugin setup for ${project}`);
      out("  • several accounts are signed in on this machine:");
      for (const a of existing) out(`      ${maskEmail(a.data.account?.email ?? "")}`);
      out("");
      out(
        "Choose explicitly: re-run with --account <email> to use one of them for this project, or with " +
          "--switch-account to sign in with a different email. Nothing was changed.",
      );
      return 4;
    }
  }
  account ??= chooseAccount(loc, origin.origin, o);
  // A project's FIRST binding never silently adopts an account that happens to be signed in
  // on this machine (it may be a different person's or a work account): ask explicitly.
  if (!bound && account && !o.account && !o.switchAccount && !o.useExisting) {
    out(`Phonebook plugin setup for ${project}`);
    out(
      `  • an account is already signed in on this machine: ${maskEmail(account.data.account?.email ?? "")}`,
    );
    out("");
    out(
      "Choose explicitly: re-run with --use-existing to use that account for this project, or with " +
        "--switch-account to sign in with a different email. Nothing was changed.",
    );
    return 4;
  }
  const reuse = await credentialUsable(origin.origin, account);

  const view = readClaudeView(project, env);
  const standaloneLocal = view.local && looksLikePhonebook(view.local) ? view.local : null;
  out(`Phonebook plugin setup for ${project}`);
  out(`  • connector ${CONNECTOR_VERSION} (bundled in the plugin)`);
  out(
    reuse
      ? `  • account: ${maskEmail(account!.data.account?.email ?? "")} (already signed in on this machine)`
      : bound && account && !o.switchAccount
        ? `  • account: sign in again as ${maskEmail(account.data.account?.email ?? "")} (this project's account)`
        : `  • account: sign in with email in your browser${o.switchAccount ? " (switching account)" : ""}`,
  );
  out(
    bound
      ? `  • project binding: exists${account && bound.participant_id !== account.data.account?.participant_id ? " (CHANGES to the selected account)" : ""}`
      : "  • project binding: add (this project only; other projects are not changed)",
  );
  if (standaloneLocal) {
    out(
      `  • standalone '${SERVER_NAME}' MCP entry (local scope): ${o.migrate ? "REPLACE with the plugin (a private rollback record is kept)" : "present"}`,
    );
  } else if (view.local) {
    out(`  • a different local MCP server named '${SERVER_NAME}' exists; it is left unchanged`);
  }
  if (view.user || view.projectFile) {
    out(
      `  • a '${SERVER_NAME}' entry in ${[view.user ? "user scope" : "", view.projectFile ? ".mcp.json" : ""].filter(Boolean).join(" and ")} ` +
        "applies beyond this setup and is left unchanged; the plugin connector stays idle while it exists",
    );
  }
  out(
    "  Nothing is registered as an answering agent, no senders are approved, and no repository content is uploaded.",
  );
  if (standaloneLocal && !o.migrate) {
    out("");
    out(
      "This project already runs the standalone Phonebook connector. Both would start, so the plugin stays idle " +
        "until that entry is replaced. To replace it, re-run setup with --migrate (asks for nothing else).",
    );
    return 3;
  }
  if (!o.yes) {
    const ok = await (o.confirm ?? (async () => false))("Continue?");
    if (!ok) {
      out("Nothing changed. (Non-interactive use: pass --yes.)");
      return 1;
    }
  }

  if (!reuse && o.noWait) {
    const device = await startSignIn(origin.origin, o);
    clearPending(loc);
    writePrivateJson(pendingFile(loc), {
      schema: 1,
      project,
      origin: origin.origin,
      migrate: o.migrate,
      rebind: o.switchAccount,
      ...(o.label ? { label: o.label } : {}),
      device,
    } satisfies PendingSignIn);
    out("Sign-in started. Nothing is bound yet. To finish, after signing in in the browser run:");
    out(`  phonebook setup-plugin --finish --project ${JSON.stringify(project)}`);
    return 5;
  }
  return withLock(loc, async () => {
    if (!reuse) account = await signInAndSave(loc, origin.origin, o);
    return bindProject(
      loc,
      s,
      project,
      account!,
      standaloneLocal,
      o.migrate,
      o.switchAccount || Boolean(o.account),
      out,
    );
  });
}

/** Second step of a --no-wait setup: wait for the browser sign-in, then bind the project. */
export async function runPluginFinish(o: {
  project?: string;
  runningEntry: string;
  env?: NodeJS.ProcessEnv;
  io?: DeviceLoginIO;
  out?: (l: string) => void;
}): Promise<number> {
  const env = o.env ?? process.env;
  const out = o.out ?? ((l: string) => console.log(l));
  const loc = locations(env);
  const project = realpathSync(o.project ?? process.cwd());
  const pending = readPending(loc);
  if (!pending || pending.project !== project) {
    out("No sign-in is in progress for this project. Run setup again.");
    return 1;
  }
  if ((o.io?.now ?? Date.now)() >= pending.device.expiresAt) {
    clearPending(loc);
    out("The sign-in code expired. Run setup again for a new code.");
    return 1;
  }
  const s = defaultSetupEnv(o.runningEntry, env);
  return withLock(loc, async () => {
    let account: Account;
    try {
      account = await finishSignIn(loc, pending.origin, pending.device, {
        ...(o.io ? { io: o.io } : {}),
        ...(pending.label ? { label: pending.label } : {}),
      });
    } finally {
      clearPending(loc);
    }
    const view = readClaudeView(project, env);
    const standaloneLocal = view.local && looksLikePhonebook(view.local) ? view.local : null;
    if (standaloneLocal && !pending.migrate) {
      out(
        "Signed in, but this project now runs the standalone Phonebook connector. Re-run setup with --migrate to replace it.",
      );
      return 3;
    }
    return bindProject(
      loc,
      s,
      project,
      account,
      standaloneLocal,
      pending.migrate,
      pending.rebind === true,
      out,
    );
  });
}

function bindProject(
  loc: Locations,
  s: ReturnType<typeof defaultSetupEnv>,
  project: string,
  account: Account,
  standaloneLocal: McpEntry | null,
  migrate: boolean,
  rebind: boolean,
  out: (l: string) => void,
): number {
  {
    const pid = account.data.account?.participant_id;
    if (!pid) throw new SetupError("The account file has no participant ID; run setup again.");
    // A browser that is still signed in to another Phonebook account can approve the device
    // sign-in without asking for an email. Never let that silently change a project's account.
    const current = readBindings(loc).projects[project];
    if (current && current.participant_id !== pid && !rebind) {
      const expected = listAccounts(loc).find(
        (a) => a.data.account?.participant_id === current.participant_id,
      );
      out(
        `Signed in as ${maskEmail(account.data.account?.email ?? "")}, but this project uses ` +
          `${maskEmail(expected?.data.account?.email ?? "") || "a different account"}. The project was NOT changed.`,
      );
      out(
        "The browser was probably still signed in to Phonebook with the other email. Sign out on the " +
          "Phonebook sign-in page (or use a private window) and run setup again, or re-run setup with " +
          "--switch-account to use the new account for this project.",
      );
      return 6;
    }
    if (standaloneLocal && migrate) {
      const m = readMigrations(loc);
      m.projects[project] = {
        entry: standaloneLocal,
        fingerprint: fingerprint(standaloneLocal),
        replaced_at: new Date().toISOString(),
      };
      writePrivateJson(migrationsFile(loc), m);
      const removed = uninstall(s, { project, apply: true });
      if (!removed.ok) throw new SetupError(removed.messages.join(" "));
    }
    const changed = writeBinding(loc, project, pid);
    out("");
    out(
      `${changed ? "Bound" : "Already bound"}: this project uses ${maskEmail(account.data.account?.email ?? "")}. ` +
        "Start a NEW Claude session here (a running session will not pick this up):",
    );
    out(`  ${pluginLaunchCommand(project)}`);
    out(
      "Claude will ask you to confirm the development channel and to approve one readiness check. " +
        "Registering an answering agent stays a separate, explicit step.",
    );
    return 0;
  }
}

/** Undo a migration for one project: restore the recorded standalone entry, drop the binding. */
export function runPluginRestore(o: {
  project?: string;
  runningEntry: string;
  env?: NodeJS.ProcessEnv;
  out?: (l: string) => void;
}): number {
  const env = o.env ?? process.env;
  const out = o.out ?? ((l: string) => console.log(l));
  const loc = locations(env);
  const project = realpathSync(o.project ?? process.cwd());
  const m = readMigrations(loc);
  const rec = m.projects[project];
  if (!rec) {
    out("No plugin migration is recorded for this project; nothing to restore.");
    return 1;
  }
  const view = readClaudeView(project, env);
  if (view.local) {
    out(`This project already has a local '${SERVER_NAME}' MCP entry; left unchanged.`);
    return 1;
  }
  if (fingerprint(rec.entry) !== rec.fingerprint)
    throw new SetupError("Migration record is inconsistent; not restoring.");
  const s = defaultSetupEnv(o.runningEntry, env);
  runClaude(s, project, [
    "mcp",
    "add-json",
    "--scope",
    "local",
    SERVER_NAME,
    JSON.stringify(rec.entry),
  ]);
  removeBinding(loc, project);
  delete m.projects[project];
  writePrivateJson(migrationsFile(loc), m);
  out("Restored the standalone Phonebook entry for this project and removed its plugin binding.");
  out(
    "Disable the plugin here if you no longer want it: claude plugin disable phonebook@phonebook --scope local",
  );
  return 0;
}

/** Local, read-only diagnosis for /phonebook:status when no live tool is available. */
export function pluginStatusReport(env: NodeJS.ProcessEnv, project: string): string {
  const st = pluginState(env, project);
  const lines = [`project:  ${project}`, `state:    ${st.kind}`];
  if (st.kind === "ready" || st.kind === "signed_out")
    lines.push(`account:  ${st.email ? maskEmail(st.email) : "(unknown)"}`);
  lines.push(describePluginState(st));
  lines.push(
    'Live channel readiness and registration exist only in a running session; ask Claude to call set_availability with action "status".',
  );
  return lines.join("\n");
}
