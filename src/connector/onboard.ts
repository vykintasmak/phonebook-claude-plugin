import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  AuthConfigResponseSchema,
  CANONICAL_ORIGIN,
  checkServiceOrigin,
  DevicesResponseSchema,
  EnrollResponseSchema,
  InstallationSelfSchema,
  type AuthConfigResponse,
} from "@agent-phonebook/protocol";
import { checkPrivateFile } from "./config.js";
import {
  deviceLogin,
  DeviceLoginError,
  pollDeviceLogin,
  startDeviceLogin,
  type DeviceAuthConfig,
  type DeviceStart,
  defaultOpenBrowser,
  defaultSleep,
  type DeviceLoginIO,
} from "./device-login.js";
import {
  checkRuntime,
  defaultSetupEnv,
  desiredEntry,
  fingerprint,
  install,
  looksLikePhonebook,
  readClaudeView,
  SetupError,
  type SetupEnv,
} from "./setup.js";
import { SERVER_NAME } from "./server.js";
import { BUILD_COMMIT, CONNECTOR_VERSION } from "./versions.js";

export const PACKAGE_NAME = "agent-phonebook";

// ---- locations ---------------------------------------------------------------------------

export interface Locations {
  configDir: string;
  accountsDir: string;
  dataDir: string;
}

export function locations(env: NodeJS.ProcessEnv = process.env): Locations {
  const configDir = env.PHONEBOOK_CONFIG_DIR ?? join(homedir(), ".config", "agent-phonebook");
  return {
    configDir,
    accountsDir: join(configDir, "accounts"),
    dataDir: env.PHONEBOOK_DATA_DIR ?? join(homedir(), ".local", "share", "agent-phonebook"),
  };
}

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Atomic private write (temp file in the same directory, then rename). */
export function writePrivateJson(path: string, value: unknown): void {
  privateDir(dirname(path));
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}

/** One random installation ID per device (and config root); never derived from host/user names. */
export function installationId(loc: Locations): string {
  const file = join(loc.configDir, "installation-id");
  if (existsSync(file)) {
    const v = readFileSync(file, "utf8").trim();
    if (/^inst_[0-9a-f]{32}$/.test(v)) return v;
  }
  privateDir(loc.configDir);
  const id = `inst_${randomBytes(16).toString("hex")}`;
  writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
}

/** Serializes setup/logout on this machine; stale after 10 minutes. */
export function withLock<T>(loc: Locations, fn: () => Promise<T>): Promise<T> {
  privateDir(loc.configDir);
  const lock = join(loc.configDir, ".setup.lock");
  try {
    const fd = openSync(lock, "wx", 0o600);
    closeSync(fd);
  } catch {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age < 10 * 60_000)
      throw new SetupError(
        "Another Phonebook setup is running on this machine; try again in a moment.",
      );
    unlinkSync(lock);
    closeSync(openSync(lock, "wx", 0o600));
  }
  return fn().finally(() => rmSync(lock, { force: true }));
}

// ---- accounts (private connector configs) ------------------------------------------------------

export interface AccountFile {
  backendUrl: string;
  credential?: string;
  account?: { participant_id: string; email: string };
  credential_id?: string;
  installation_id?: string;
  expires_at?: number;
  issued_at?: number;
}

export interface Account {
  path: string;
  data: AccountFile;
}

export function listAccounts(loc: Locations): Account[] {
  if (!existsSync(loc.accountsDir)) return [];
  return readdirSync(loc.accountsDir)
    .filter((f) => /^p_[0-9a-f]{32}\.json$/.test(f))
    .map((f) => {
      const path = join(loc.accountsDir, f);
      return { path, data: JSON.parse(readFileSync(path, "utf8")) as AccountFile };
    });
}

export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 2)}${"*".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

// ---- backend API (credential-bearing calls never follow redirects) ------------------------------

async function backend(origin: string, path: string, init: RequestInit & { bearer?: string } = {}) {
  const { bearer, ...rest } = init;
  const res = await fetch(`${origin}${path}`, {
    ...rest,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON
  }
  return { status: res.status, body: body as Record<string, unknown> | null };
}

export async function fetchAuthConfig(origin: string): Promise<AuthConfigResponse> {
  const r = await backend(origin, "/api/auth/config");
  const parsed = AuthConfigResponseSchema.safeParse(r.body);
  if (r.status !== 200 || !parsed.success)
    throw new SetupError(
      `Could not read Phonebook sign-in settings from ${origin} (HTTP ${r.status}).`,
    );
  return parsed.data;
}

function backendError(
  status: number,
  body: Record<string, unknown> | null,
  what: string,
): SetupError {
  const msg = typeof body?.message === "string" ? body.message : `HTTP ${status}`;
  return new SetupError(`${what} failed: ${msg}`);
}

function ioDefaults(): DeviceLoginIO {
  return {
    say: (l) => process.stderr.write(`${l}\n`),
    openBrowser: defaultOpenBrowser,
    sleep: defaultSleep,
    fetch,
    now: Date.now,
  };
}

/** Fresh human login via WorkOS (token kept in memory only). */
function trustedEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    return (
      u.protocol === "https:" ||
      (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
    );
  } catch {
    return false;
  }
}

function deviceConfig(cfg: AuthConfigResponse): DeviceAuthConfig {
  if (!cfg.workos) throw new SetupError("Phonebook sign-in is not available right now.");
  if (
    !trustedEndpoint(cfg.workos.device_authorization_endpoint) ||
    !trustedEndpoint(cfg.workos.token_endpoint)
  ) {
    throw new SetupError("Phonebook sign-in settings point at an insecure endpoint; stopping.");
  }
  return {
    clientId: cfg.workos.client_id,
    authkitOrigin: cfg.workos.authkit_origin,
    deviceAuthorizationEndpoint: cfg.workos.device_authorization_endpoint,
    tokenEndpoint: cfg.workos.token_endpoint,
  };
}

async function signUpConfig(origin: string): Promise<DeviceAuthConfig> {
  const cfg = await fetchAuthConfig(origin);
  if (!cfg.self_service_enabled || !cfg.workos)
    throw new SetupError("Phonebook self-service sign-up is not open right now.");
  return deviceConfig(cfg);
}

const asSetupError = (err: unknown): never => {
  if (err instanceof DeviceLoginError) throw new SetupError(err.message);
  throw err;
};

/** One-shot sign-in (devices): start and wait in one call; no sign-up check. */
async function humanLogin(
  cfg: AuthConfigResponse,
  opts: { noBrowser: boolean; io?: DeviceLoginIO },
) {
  return deviceLogin(deviceConfig(cfg), opts.io ?? ioDefaults(), {
    noBrowser: opts.noBrowser,
  }).catch(asSetupError);
}

/** Phase 1: start email/device sign-in and show the confirmation code. Returns at once. */
export async function startSignIn(
  origin: string,
  o: { noBrowser: boolean; io?: DeviceLoginIO },
): Promise<DeviceStart> {
  const cfg = await signUpConfig(origin);
  return startDeviceLogin(cfg, o.io ?? ioDefaults(), { noBrowser: o.noBrowser }).catch(
    asSetupError,
  );
}

/** Phase 2: wait for the browser sign-in, enroll this installation and save it privately. */
export async function finishSignIn(
  loc: Locations,
  origin: string,
  start: DeviceStart,
  o: { io?: DeviceLoginIO; label?: string; signal?: AbortSignal },
): Promise<Account> {
  const cfg = await signUpConfig(origin);
  const login = await pollDeviceLogin(
    cfg,
    o.io ?? ioDefaults(),
    start,
    o.signal ? { signal: o.signal } : {},
  ).catch(asSetupError);
  return enrollAndSave(loc, origin, login.accessToken, o.label);
}

// ---- managed installation ------------------------------------------------------------------------

/**
 * Copies the RUNNING package's runtime files into a versioned, user-owned
 * directory (outside the npm cache and the project), atomically. Reuses an
 * identical existing copy; refuses a same-version directory from another build.
 */
export function provisionManagedInstall(
  loc: Locations,
  runningEntry: string,
  env = process.env,
): { entry: string; reused: boolean; dir: string } {
  const sourceRoot = env.PHONEBOOK_MANAGED_SOURCE ?? dirname(dirname(runningEntry));
  const manifestPath = join(sourceRoot, "package.json");
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name?: string;
        version?: string;
        files?: string[];
      })
    : {};
  if (manifest.name !== PACKAGE_NAME || !existsSync(join(sourceRoot, "bundle", "phonebook.mjs"))) {
    throw new SetupError(
      "setup must run from the published agent-phonebook package (e.g. npx agent-phonebook@<version> setup).",
    );
  }
  const version = manifest.version ?? CONNECTOR_VERSION;
  const dir = join(loc.dataDir, version);
  const entry = join(dir, "bundle", "phonebook.mjs");
  const buildOf = (root: string) => {
    try {
      return (
        (
          JSON.parse(readFileSync(join(root, "BUILD_INFO.json"), "utf8")) as {
            source_commit?: string;
          }
        ).source_commit ?? null
      );
    } catch {
      return null;
    }
  };
  if (realpathSync(sourceRoot) === (existsSync(dir) ? realpathSync(dir) : ""))
    return { entry, reused: true, dir };
  if (existsSync(dir)) {
    if (buildOf(dir) && buildOf(dir) === buildOf(sourceRoot)) return { entry, reused: true, dir };
    throw new SetupError(
      `${dir} already holds a different build of ${version}; remove it only if no project uses it.`,
    );
  }
  privateDir(loc.dataDir);
  const tmp = join(loc.dataDir, `.${version}.tmp-${randomBytes(4).toString("hex")}`);
  mkdirSync(tmp, { mode: 0o755 });
  for (const f of [
    "package.json",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "BUILD_INFO.json",
    "bundle",
  ]) {
    if (existsSync(join(sourceRoot, f)))
      cpSync(join(sourceRoot, f), join(tmp, f), { recursive: true });
  }
  renameSync(tmp, dir);
  return { entry, reused: false, dir };
}

// ---- setup -----------------------------------------------------------------------------------------

export interface SetupOptions {
  project?: string;
  backend?: string;
  yes: boolean;
  replace: boolean;
  noBrowser: boolean;
  switchAccount: boolean;
  account?: string;
  label?: string;
  runningEntry: string;
  env?: NodeJS.ProcessEnv;
  io?: DeviceLoginIO;
  confirm?: (question: string) => Promise<boolean>;
  out?: (line: string) => void;
}

/** Which signed-in account a project uses (explicit, the only one, or none yet). */
export function chooseAccount(
  loc: Locations,
  origin: string,
  o: { account?: string; switchAccount: boolean },
): Account | null {
  const accounts = listAccounts(loc).filter((a) => a.data.backendUrl === origin);
  let account: Account | null = null;
  if (!o.switchAccount) {
    if (o.account) {
      account =
        accounts.find(
          (a) =>
            a.data.account?.email === o.account!.toLowerCase() ||
            a.data.account?.participant_id === o.account,
        ) ?? null;
      if (!account)
        throw new SetupError(
          `No signed-in account matches ${o.account}; use --switch-account to sign in with another email.`,
        );
    } else if (accounts.length === 1) {
      account = accounts[0]!;
    } else if (accounts.length > 1) {
      throw new SetupError(
        "Several Phonebook accounts are signed in on this machine; pass --account <email> or --switch-account.",
      );
    }
  }
  return account;
}

/** True when the saved installation credential still authenticates. */
export async function credentialUsable(origin: string, account: Account | null): Promise<boolean> {
  if (!account?.data.credential) return false;
  const r = await backend(origin, "/api/auth/installations/self", {
    bearer: account.data.credential,
  });
  return r.status === 200 && InstallationSelfSchema.safeParse(r.body).success;
}

/** WorkOS email/device sign-in, installation enrollment and the private account file. */
export async function signInAndSave(
  loc: Locations,
  origin: string,
  o: { noBrowser: boolean; io?: DeviceLoginIO; label?: string },
): Promise<Account> {
  const start = await startSignIn(origin, o);
  return finishSignIn(loc, origin, start, o);
}

/** Enrolls this machine's installation with a fresh WorkOS access token and saves it (0600). */
async function enrollAndSave(
  loc: Locations,
  origin: string,
  accessToken: string,
  label?: string,
): Promise<Account> {
  const inst = installationId(loc);
  const r = await backend(origin, "/api/auth/installations", {
    method: "POST",
    bearer: accessToken,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      installation_id: inst,
      connector_version: CONNECTOR_VERSION,
      ...(label ? { label } : {}),
    }),
  });
  const enrolled = EnrollResponseSchema.safeParse(r.body);
  if (r.status !== 201 || !enrolled.success) throw backendError(r.status, r.body, "Sign-in");
  const e = enrolled.data;
  const path = join(loc.accountsDir, `${e.participant_id}.json`);
  try {
    writePrivateJson(path, {
      backendUrl: origin,
      credential: e.token,
      account: { participant_id: e.participant_id, email: e.email },
      credential_id: e.credential_id,
      installation_id: inst,
      expires_at: e.expires_at,
      issued_at: Date.now(),
    } satisfies AccountFile);
  } catch (err) {
    await backend(origin, "/api/auth/installations/self/revoke", {
      method: "POST",
      bearer: e.token,
    }).catch(() => null);
    throw new SetupError(
      `Could not save the credential locally (${(err as Error).message}); it was revoked.`,
    );
  }
  return { path, data: JSON.parse(readFileSync(path, "utf8")) as AccountFile };
}

async function ttyConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export async function runSetup(o: SetupOptions): Promise<number> {
  const env = o.env ?? process.env;
  const out = o.out ?? ((l: string) => console.log(l));
  const loc = locations(env);
  const project = realpathSync(o.project ?? process.cwd());
  if (!statSync(project).isDirectory()) throw new SetupError(`Not a directory: ${project}`);
  const origin = checkServiceOrigin(o.backend ?? env.PHONEBOOK_BACKEND_URL ?? CANONICAL_ORIGIN);
  if (!origin.ok) throw new SetupError(`Backend URL: ${origin.reason}`);

  const runtime = checkRuntime(defaultSetupEnv(o.runningEntry, env));
  const failed = runtime.filter((c) => c.level === "fail");
  if (failed.length) throw new SetupError(failed.map((c) => `${c.name}: ${c.detail}`).join("; "));

  let account: Account | null = chooseAccount(loc, origin.origin, o);
  const reuse = await credentialUsable(origin.origin, account);

  // Plan the local changes.
  const s: SetupEnv = defaultSetupEnv(o.runningEntry, env);
  const view = readClaudeView(project, env);
  const managedPreview = join(loc.dataDir, CONNECTOR_VERSION, "bundle", "phonebook.mjs");
  const wantPreview = account
    ? desiredEntry({ ...s, connectorEntry: managedPreview }, realpathSync(account.path))
    : null;
  const entryState = !view.local
    ? "add"
    : wantPreview && fingerprint(view.local) === fingerprint(wantPreview)
      ? "same"
      : looksLikePhonebook(view.local)
        ? "replace"
        : "foreign";
  if (entryState === "foreign") {
    throw new SetupError(
      `This project already has a different MCP server named '${SERVER_NAME}'; remove it first: claude mcp remove --scope local ${SERVER_NAME}`,
    );
  }
  out(`Phonebook setup for ${project}`);
  out(`  • connector ${CONNECTOR_VERSION} → ${join(loc.dataDir, CONNECTOR_VERSION)}`);
  out(
    reuse
      ? `  • account: ${maskEmail(account!.data.account?.email ?? "")} (already signed in on this machine)`
      : `  • account: sign in with email in your browser${o.switchAccount ? " (switching account)" : ""}`,
  );
  out(
    entryState === "same"
      ? `  • Claude MCP entry '${SERVER_NAME}' (local scope): already up to date`
      : entryState === "replace"
        ? `  • Claude MCP entry '${SERVER_NAME}' (local scope): REPLACE an existing Phonebook entry (different version/account)`
        : `  • Claude MCP entry '${SERVER_NAME}' (local scope): add for this project only`,
  );
  out("  Nothing is registered as an answering agent, and no repository content is uploaded.");
  if (entryState === "replace" && o.yes && !o.replace) {
    throw new SetupError(
      "An existing Phonebook entry would be replaced; re-run with --yes --replace to confirm.",
    );
  }
  if (!o.yes) {
    const ok = await (o.confirm ?? ttyConfirm)(
      entryState === "replace" ? "Replace the existing Phonebook entry and continue?" : "Continue?",
    );
    if (!ok) {
      out("Nothing changed. (Non-interactive use: pass --yes.)");
      return 1;
    }
  }

  return withLock(loc, async () => {
    const managed = provisionManagedInstall(loc, o.runningEntry, env);
    if (!reuse) account = await signInAndSave(loc, origin.origin, o);
    const result = install(
      { ...s, connectorEntry: managed.entry },
      { project, config: account!.path, apply: true, replace: true },
    );
    if (!result.ok) throw new SetupError(result.messages.join(" "));
    out("");
    out(
      `Installed for this project; signed in as ${maskEmail(account!.data.account?.email ?? "")}; ready to launch Claude:`,
    );
    out(`  npx ${PACKAGE_NAME}@${CONNECTOR_VERSION} claude`);
    out("Claude will ask you to confirm the custom channel and approve one readiness check.");
    return 0;
  });
}

// ---- claude launcher -----------------------------------------------------------------------------

export async function runClaude(o: {
  project?: string;
  args: string[];
  runningEntry: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const env = o.env ?? process.env;
  const project = realpathSync(o.project ?? process.cwd());
  const s = defaultSetupEnv(o.runningEntry, env);
  const view = readClaudeView(project, env);
  if (!view.local || !looksLikePhonebook(view.local)) {
    process.stderr.write(
      `Phonebook is not set up for ${project}. Run: npx ${PACKAGE_NAME}@${CONNECTOR_VERSION} setup\n`,
    );
    return 2;
  }
  const installed = /\/(\d+\.\d+\.\d+[^/]*)\/bundle\/phonebook\.mjs$/.exec(
    view.local.args[0] ?? "",
  )?.[1];
  if (installed && installed !== CONNECTOR_VERSION) {
    process.stderr.write(
      `Note: this project uses Phonebook ${installed}; launching it unchanged (run setup --replace to change).\n`,
    );
  }
  const args = ["--dangerously-load-development-channels", `server:${SERVER_NAME}`, ...o.args];
  return new Promise((resolve) => {
    const child = spawn(s.claudeBin, args, {
      cwd: project,
      stdio: "inherit",
      // Negotiation must be set on the Claude process itself.
      env: { ...env, MCP_PROTOCOL_NEGOTIATION: "legacy" },
    });
    // The terminal delivers Ctrl-C to the whole foreground group; Claude handles it.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    child.once("error", (err) => {
      process.off("SIGINT", ignore);
      process.stderr.write(`Could not start Claude (${s.claudeBin}): ${err.message}\n`);
      resolve(127);
    });
    child.once("exit", (code, signal) => {
      process.off("SIGINT", ignore);
      resolve(
        code ??
          (signal
            ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as Record<string, number>)[signal]! || 1
            : 1),
      );
    });
    process.once("SIGTERM", () => child.kill("SIGTERM"));
  });
}

// ---- logout and devices --------------------------------------------------------------------------

function pickAccount(loc: Locations, accountArg?: string): Account {
  const accounts = listAccounts(loc);
  const match = accountArg
    ? accounts.filter(
        (a) =>
          a.data.account?.email === accountArg.toLowerCase() ||
          a.data.account?.participant_id === accountArg,
      )
    : accounts;
  if (match.length === 1) return match[0]!;
  throw new SetupError(
    match.length
      ? "Several accounts are signed in; pass --account <email>."
      : "No signed-in Phonebook account on this machine.",
  );
}

export async function runLogout(o: {
  account?: string;
  localOnly: boolean;
  env?: NodeJS.ProcessEnv;
  out?: (l: string) => void;
}): Promise<number> {
  const out = o.out ?? ((l: string) => console.log(l));
  const loc = locations(o.env);
  return withLock(loc, async () => {
    const acct = pickAccount(loc, o.account);
    if (!acct.data.credential) {
      out("Already signed out on this machine.");
      return 0;
    }
    if (checkPrivateFile(acct.path).length)
      throw new SetupError(`${acct.path} is not private (chmod 600).`);
    let revoked = false;
    try {
      const r = await backend(acct.data.backendUrl, "/api/auth/installations/self/revoke", {
        method: "POST",
        bearer: acct.data.credential,
      });
      revoked = r.status === 200;
      if (!revoked && r.status !== 401) throw backendError(r.status, r.body, "Sign-out");
      if (r.status === 401) revoked = true; // already invalid server-side
    } catch (err) {
      if (!o.localOnly) {
        throw new SetupError(
          `${(err as Error).message}. Nothing removed; retry when online, or pass --local-only (the credential may stay valid remotely until it expires).`,
        );
      }
    }
    const { credential: _drop, ...rest } = acct.data;
    void _drop;
    writePrivateJson(acct.path, rest);
    out(
      revoked
        ? `Signed out ${maskEmail(acct.data.account?.email ?? "")} on this machine; its sessions were closed. Project entries remain; run setup to sign in again.`
        : "Removed the local credential WITHOUT server revocation; it may stay valid until it expires or is revoked from another device (phonebook devices).",
    );
    return 0;
  });
}

export async function runDevices(o: {
  revoke?: string;
  backend?: string;
  noBrowser: boolean;
  env?: NodeJS.ProcessEnv;
  io?: DeviceLoginIO;
  out?: (l: string) => void;
}): Promise<number> {
  const out = o.out ?? ((l: string) => console.log(l));
  const env = o.env ?? process.env;
  const origin = checkServiceOrigin(o.backend ?? env.PHONEBOOK_BACKEND_URL ?? CANONICAL_ORIGIN);
  if (!origin.ok) throw new SetupError(`Backend URL: ${origin.reason}`);
  const cfg = await fetchAuthConfig(origin.origin);
  const login = await humanLogin(cfg, { noBrowser: o.noBrowser, ...(o.io ? { io: o.io } : {}) });
  const current = new Set(
    listAccounts(locations(env))
      .map((a) => a.data.credential_id)
      .filter(Boolean),
  );
  if (o.revoke) {
    const r = await backend(
      origin.origin,
      `/api/auth/devices/${encodeURIComponent(o.revoke)}/revoke`,
      { method: "POST", bearer: login.accessToken },
    );
    if (r.status !== 200) throw backendError(r.status, r.body, "Revoking the installation");
    out(`Revoked installation ${o.revoke}; its sessions were closed.`);
    return 0;
  }
  const r = await backend(origin.origin, "/api/auth/devices", { bearer: login.accessToken });
  const parsed = DevicesResponseSchema.safeParse(r.body);
  if (r.status !== 200 || !parsed.success)
    throw backendError(r.status, r.body, "Listing installations");
  if (!parsed.data.devices.length) out("No installations on this account.");
  for (const d of parsed.data.devices) {
    const state = d.revoked_at ? "revoked" : d.expires_at < Date.now() ? "expired" : "active";
    out(
      `${d.credential_id}  ${state.padEnd(7)}  created ${new Date(d.created_at).toISOString().slice(0, 10)}  expires ${new Date(d.expires_at).toISOString().slice(0, 10)}${current.has(d.credential_id) ? "  (this machine)" : ""}${d.label ? `  ${d.label}` : ""}`,
    );
  }
  return 0;
}

export const VERSION_STRING = BUILD_COMMIT
  ? `${CONNECTOR_VERSION} (${BUILD_COMMIT})`
  : CONNECTOR_VERSION;
void basename;
