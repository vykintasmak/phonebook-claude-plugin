#!/usr/bin/env node
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { API_PATHS, CANONICAL_ORIGIN, HealthResponseSchema } from "@agent-phonebook/protocol";
import { ConfigError, DEFAULT_CONFIG_PATH, loadConfig, type ResolvedConfig } from "./config.js";
import { createHostedSession } from "./hosted.js";
import { readReceipts } from "./receipts.js";
import { createDiagnosticSession, SERVER_NAME, stderrLog } from "./server.js";
import {
  defaultSetupEnv,
  doctor,
  install,
  SetupError,
  uninstall,
  type Check,
  type PlanResult,
} from "./setup.js";
import { liveStatusFiles, statusFileFor } from "./cli-status.js";
import { runClaude, runDevices, runLogout, runSetup } from "./onboard.js";
import {
  createIdleSession,
  PLUGIN_TOOL_PREFIX,
  pluginState,
  pluginStatusReport,
  resolvePluginProject,
  runPluginRestore,
  runPluginFinish,
  runPluginSetup,
} from "./plugin.js";
import { BUILD_COMMIT, CONNECTOR_VERSION, MCP_SDK_VERSION } from "./versions.js";

const MIN_NODE_MAJOR = 24;
const CLI_PATH = realpathSync(fileURLToPath(import.meta.url));

const USAGE = `agent-phonebook ${CONNECTOR_VERSION} — Phonebook connector for Claude Code

Get started (in your project directory):
  npx agent-phonebook@${CONNECTOR_VERSION} setup     sign in with email and add Phonebook to this project
  npx agent-phonebook@${CONNECTOR_VERSION} claude    start Claude with the Phonebook channel

Account:
  phonebook setup [--project <dir>] [--yes] [--replace] [--no-browser]
                  [--switch-account | --account <email>] [--label <name>]
      Shows the changes first, signs you in with an email code in the browser (no GitHub),
      stores a private per-installation credential, and adds the 'phonebook' MCP server at
      Claude LOCAL scope for this project only. Never registers you as an answering agent.
  phonebook claude [--project <dir>] [-- <claude arguments>]
      Runs Claude in the project with the Phonebook development channel enabled. You still
      confirm the channel and approve tool calls in Claude.
  phonebook logout [--account <email>] [--local-only]
      Revokes this machine's credential (closing its sessions) and removes it locally.
  phonebook devices [revoke <credential-id>] [--no-browser]
      Lists or revokes your installations after a fresh email sign-in.

Claude Code plugin (run by the plugin; see https://phonebook.dev/plugin):
  phonebook setup-plugin [--project <dir>] [--yes] [--migrate] [--no-browser]
                         [--use-existing | --switch-account | --account <email>] [--label <name>]
                         [--no-wait]
      Same email sign-in and private credential as setup, but binds the project for the
      plugin instead of adding an MCP entry. --migrate replaces this project's standalone
      local entry (a private rollback record is kept). Never registers an answering agent.
      --no-wait shows the sign-in code and exits (code 5); then run:
  phonebook setup-plugin --finish [--project <dir>]   wait for the browser sign-in and bind
  phonebook restore-standalone [--project <dir>]   undo a migration for one project
  phonebook plugin-status [--project <dir>]        read-only local plugin diagnosis
  phonebook serve-plugin                           stdio MCP server (started by the plugin)

Advanced and pilot:
  phonebook install --project <abs-path> --config <abs-private-config> [--apply] [--replace]
  phonebook doctor --project <abs-path> [--config <abs-private-config>] [--offline] [--json]
  phonebook uninstall --project <abs-path> [--apply]
      Remove only this project's Phonebook entry (does not sign out).
  phonebook serve [--config <path>]          stdio MCP server (started by Claude)
  phonebook status [--config <path>]         local view of running connectors for a config
  phonebook diagnose | check | print-config | receipts   developer diagnostics
  phonebook --version | --help
`;

const MARK: Record<Check["level"], string> = {
  ok: "ok   ",
  warn: "warn ",
  fail: "FAIL ",
  info: "info ",
};

function printChecks(checks: Check[]): void {
  for (const c of checks) console.log(`${MARK[c.level]} ${c.name.padEnd(14)} ${c.detail}`);
}

function printPlan(r: PlanResult, json: boolean): number {
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    printChecks(r.checks);
    if (r.preview.length) {
      console.log(r.applied ? "\nApplied:" : "\nWould run:");
      for (const line of r.preview) console.log(`  ${line}`);
    }
    if (r.messages.length) console.log(`\n${r.messages.join("\n")}`);
  }
  return r.ok ? 0 : 1;
}

function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0]);
}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return n;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runServe(configPath: string, plugin = false): Promise<void> {
  const config = loadConfig(configPath);
  const statusFile = statusFileFor(configPath);
  liveStatusFiles(configPath); // prune files left by crashed instances
  const session = createHostedSession({
    config,
    log: stderrLog,
    statusFile,
    ...(plugin
      ? {
          naming: {
            tool: (name: string) => `${PLUGIN_TOOL_PREFIX}${name}`,
            source: 'source="plugin:phonebook:phonebook"',
          },
        }
      : {}),
  });
  process.once("exit", () => rmSync(statusFile, { force: true }));
  installShutdown(() => {
    session.shutdown();
    return session.server.close();
  });
  // MCP initialization over stdio never waits on the backend.
  await session.server.connect(session.observe(new StdioServerTransport()));
  stderrLog(`pilot mode (${config.mode}, ${config.backendOrigin}); connecting transport`);
  session.start();
}

/**
 * Plugin entry point: serves this Claude project's bound account, or an idle server
 * (no backend, no socket, no login) that explains how to set Phonebook up.
 */
async function runServePlugin(): Promise<void> {
  const project = resolvePluginProject(process.env);
  const state = pluginState(process.env, project);
  if (state.kind === "ready") {
    stderrLog(`plugin mode for ${project}`);
    await runServe(state.configPath, true);
    return;
  }
  stderrLog(`plugin idle (${state.kind}) for ${project}`);
  const server = createIdleSession(state);
  installShutdown(() => server.close());
  await server.connect(new StdioServerTransport());
}

function showStatus(configPath: string): number {
  const files = liveStatusFiles(configPath);
  if (!files.length) {
    console.log(`No running connector found for ${configPath}.`);
    return 1;
  }
  for (const [i, file] of files.entries()) {
    if (files.length > 1) console.log(`${i ? "\n" : ""}== instance ${basename(file, ".json")} ==`);
    printStatus(file);
  }
  return 0;
}

function printStatus(file: string): void {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    console.log(`(status unavailable: ${file})`);
    return;
  }
  const s = JSON.parse(raw) as import("./hosted.js").LocalStatus;
  console.log(`backend:    ${s.backend_origin}   (updated ${s.updated_at}, run ${s.run_id})`);
  console.log(
    `transport:  ${s.transport.state}  session=${s.transport.session_id ?? "-"}  connected=${s.transport.connected_at ?? "-"}  ` +
      `last_ack=${s.transport.last_heartbeat_ack_at ?? "-"}  lease_until=${s.transport.lease_expires_at ?? "-"}` +
      (s.transport.terminal_reason ? `  STOPPED: ${s.transport.terminal_reason}` : ""),
  );
  console.log(
    `channel:    ${s.channel.state}  session=${s.channel.session_id ?? "-"}  challenge_at=${s.channel.challenge_received_at ?? "-"}  ` +
      `confirmed=${s.channel.confirmed_at ?? "-"}  last=${s.channel.last_outcome ?? "-"}`,
  );
  console.log(
    `mcp:        protocol=${s.mcp?.negotiated_protocol_version ?? "unobserved"}  client=${s.mcp?.client ? `${s.mcp.client.name}@${s.mcp.client.version}` : "-"}`,
  );
  console.log(
    `registration: ${s.registration ? `${s.registration.agent_id} published=${s.registration.published} receiving=${s.registration.receiving}` : "none (not an answering agent)"}`,
  );
  console.log(
    `pending asks: ${s.pending_asks.length ? s.pending_asks.map((p) => `${p.idempotency_key}→${p.phonebook_request_id ?? "unacknowledged"}`).join(", ") : "none"}`,
  );
  console.log(s.note);
}

async function runDiagnose(receiptsDir: string | null, label: string | null): Promise<void> {
  const ttlMs = intFromEnv("PHONEBOOK_DIAG_TTL_MS", 180_000, 5_000, 3_600_000);
  const session = createDiagnosticSession({
    ttlMs,
    emitDelaysMs: [3_000, 45_000],
    receiptsDir,
    label,
  });
  const transport = session.observe(new StdioServerTransport());
  installShutdown(() => {
    session.shutdown();
    return session.server.close();
  });
  session.server.onclose = () => session.shutdown();
  await session.server.connect(transport);
  stderrLog(
    `diagnostic mode, run ${session.diagnostic.runId}${label ? ` (${label})` : ""}; ` +
      (receiptsDir ? `receipts in ${receiptsDir}` : "no receipts directory configured"),
  );
}

function installShutdown(close: () => Promise<void> | void): void {
  let done = false;
  const stop = (code: number) => {
    if (done) return;
    done = true;
    Promise.resolve()
      .then(close)
      .catch(() => undefined)
      .finally(() => process.exit(code));
  };
  process.stdin.on("end", () => stop(0));
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
}

async function runCheck(configPath: string, explicitConfig: boolean, probe: boolean) {
  let failures = 0;
  const ok = (m: string) => console.log(`ok    ${m}`);
  const warn = (m: string) => console.log(`warn  ${m}`);
  const fail = (m: string) => {
    failures++;
    console.log(`FAIL  ${m}`);
  };

  if (nodeMajor() >= MIN_NODE_MAJOR) ok(`Node ${process.version}`);
  else fail(`Node ${process.version}; Node ${MIN_NODE_MAJOR}+ is required`);
  ok(`connector ${CONNECTOR_VERSION}, MCP SDK ${MCP_SDK_VERSION}`);
  ok(`entry point ${CLI_PATH}`);

  let config: ResolvedConfig | null = null;
  try {
    config = loadConfig(configPath);
    ok(
      `config ${configPath}: ${config.mode} backend ${config.backendOrigin} (owner-only file, credential not shown)`,
    );
    if (config.mode === "hosted" && config.backendOrigin !== CANONICAL_ORIGIN) {
      warn(`backend is not the canonical origin ${CANONICAL_ORIGIN}`);
    }
  } catch (err) {
    if (explicitConfig) fail((err as Error).message);
    else warn(`no pilot config (${(err as Error).message}); diagnostic mode does not need one`);
  }

  if (probe) {
    if (!config) {
      fail("--probe needs a valid configuration");
    } else {
      try {
        const res = await fetch(`${config.backendOrigin}${API_PATHS.health}`, {
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
        const body = HealthResponseSchema.safeParse(await res.json().catch(() => null));
        if (res.ok && body.success) ok(`backend health ${res.status} (${body.data.phase})`);
        else fail(`backend health returned ${res.status}`);
      } catch (err) {
        fail(`backend health request failed: ${(err as Error).message}`);
      }
    }
  }
  return failures === 0 ? 0 : 1;
}

function printConfig(
  project: string,
  label: string | null,
  receiptsDir: string | null,
  asJson: boolean,
  pilotConfig: string | null,
): void {
  const dir = resolve(project);
  const receipts = resolve(receiptsDir ?? `${dir}/.phonebook/receipts`);
  // Pilot mode stores only the private config PATH in Claude's MCP config.
  const env = pilotConfig
    ? ["--env", `PHONEBOOK_CONFIG=${resolve(pilotConfig)}`]
    : [
        "--env",
        `PHONEBOOK_DIAG_DIR=${receipts}`,
        ...(label ? ["--env", `PHONEBOOK_DIAG_LABEL=${label}`] : []),
      ];
  const args = [
    "claude",
    "mcp",
    "add",
    ...env,
    // An option must separate --env pairs from the server name.
    "--scope",
    "local",
    "--transport",
    "stdio",
    SERVER_NAME,
    "--",
    process.execPath,
    CLI_PATH,
    pilotConfig ? "serve" : "diagnose",
  ];
  if (asJson) console.log(JSON.stringify({ cwd: dir, argv: args }));
  else console.log(`cd ${shellQuote(dir)} && ${args.map(shellQuote).join(" ")}`);
}

function showReceipts(dir: string): void {
  const receipts = readReceipts(dir);
  if (!receipts.length) {
    console.log(`No receipts in ${dir}.`);
    return;
  }
  for (const r of receipts) {
    console.log(
      [
        r.started_at,
        r.label ?? "-",
        r.run_id,
        r.outcome,
        `emitted=${r.challenge_emissions.length}`,
        `confirmed=${r.confirmed_at ?? "-"}`,
        `dupes=${r.duplicate_confirmations}`,
        `rejected=${r.rejected_confirmations}`,
        `protocol=${r.versions.negotiated_protocol_version ?? "unobserved"}`,
        `client=${r.versions.client ? `${r.versions.client.name}@${r.versions.client.version}` : "-"}`,
      ].join("  "),
    );
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "claude") {
    const split = rest.indexOf("--");
    const own = split >= 0 ? rest.slice(0, split) : rest;
    const { values: v } = parseArgs({
      args: own,
      options: { project: { type: "string" } },
      strict: true,
    });
    return runClaude({
      ...(v.project ? { project: v.project } : {}),
      args: split >= 0 ? rest.slice(split + 1) : [],
      runningEntry: CLI_PATH,
    });
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: command === "devices",
    options: {
      config: { type: "string" },
      "receipts-dir": { type: "string" },
      label: { type: "string" },
      project: { type: "string" },
      probe: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "pilot-config": { type: "string" },
      apply: { type: "boolean", default: false },
      replace: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      "no-browser": { type: "boolean", default: false },
      "switch-account": { type: "boolean", default: false },
      account: { type: "string" },
      backend: { type: "string" },
      "local-only": { type: "boolean", default: false },
      migrate: { type: "boolean", default: false },
      "use-existing": { type: "boolean", default: false },
      "no-wait": { type: "boolean", default: false },
      finish: { type: "boolean", default: false },
    },
    strict: true,
  });
  const configPath = resolve(values.config ?? process.env.PHONEBOOK_CONFIG ?? DEFAULT_CONFIG_PATH);
  const explicitConfig = Boolean(values.config ?? process.env.PHONEBOOK_CONFIG);
  const receiptsDir = values["receipts-dir"] ?? process.env.PHONEBOOK_DIAG_DIR ?? null;
  const label = values.label ?? process.env.PHONEBOOK_DIAG_LABEL ?? null;

  switch (command) {
    case "setup":
      if (values["switch-account"] && values.account) {
        throw new SetupError("Use either --switch-account or --account, not both.");
      }
      return runSetup({
        ...(values.project ? { project: values.project } : {}),
        ...(values.backend ? { backend: values.backend } : {}),
        ...(values.account ? { account: values.account } : {}),
        ...(values.label ? { label: values.label } : {}),
        yes: values.yes,
        replace: values.replace,
        noBrowser: values["no-browser"],
        switchAccount: values["switch-account"],
        runningEntry: CLI_PATH,
      });
    case "logout":
      return runLogout({
        ...(values.account ? { account: values.account } : {}),
        localOnly: values["local-only"],
      });
    case "devices": {
      const [sub, id, ...extra] = positionals;
      if (extra.length || (sub && sub !== "revoke") || (sub === "revoke" && !id)) {
        throw new SetupError("Usage: phonebook devices [revoke <credential-id>]");
      }
      return runDevices({
        ...(id ? { revoke: id } : {}),
        ...(values.backend ? { backend: values.backend } : {}),
        noBrowser: values["no-browser"],
      });
    }
    case "serve":
      if (nodeMajor() < MIN_NODE_MAJOR) throw new ConfigError(`Node ${MIN_NODE_MAJOR}+ required.`);
      await runServe(configPath);
      return -1;
    case "serve-plugin":
      if (nodeMajor() < MIN_NODE_MAJOR) throw new ConfigError(`Node ${MIN_NODE_MAJOR}+ required.`);
      await runServePlugin();
      return -1;
    case "setup-plugin":
      if (values.finish)
        return runPluginFinish({
          ...(values.project ? { project: values.project } : {}),
          runningEntry: CLI_PATH,
        });
      return runPluginSetup({
        ...(values.project ? { project: values.project } : {}),
        ...(values.backend ? { backend: values.backend } : {}),
        ...(values.account ? { account: values.account } : {}),
        ...(values.label ? { label: values.label } : {}),
        yes: values.yes,
        migrate: values.migrate,
        useExisting: values["use-existing"],
        noBrowser: values["no-browser"],
        switchAccount: values["switch-account"],
        noWait: values["no-wait"],
        runningEntry: CLI_PATH,
      });
    case "restore-standalone":
      return runPluginRestore({
        ...(values.project ? { project: values.project } : {}),
        runningEntry: CLI_PATH,
      });
    case "plugin-status": {
      const project = values.project
        ? realpathSync(values.project)
        : resolvePluginProject(process.env);
      console.log(pluginStatusReport(process.env, project));
      return 0;
    }
    case "install": {
      const setup = defaultSetupEnv(CLI_PATH);
      return printPlan(
        install(setup, {
          project: values.project,
          config: values.config,
          apply: values.apply,
          replace: values.replace,
        }),
        values.json,
      );
    }
    case "uninstall":
      return printPlan(
        uninstall(defaultSetupEnv(CLI_PATH), { project: values.project, apply: values.apply }),
        values.json,
      );
    case "doctor": {
      const r = await doctor(defaultSetupEnv(CLI_PATH), {
        project: values.project,
        config: values.config,
        offline: values.offline,
      });
      if (values.json) console.log(JSON.stringify(r, null, 2));
      else {
        printChecks(r.checks);
        console.log(r.ok ? "\nLocal setup looks valid." : "\nProblems found (see FAIL lines).");
      }
      return r.ok ? 0 : 1;
    }
    case "status":
      return showStatus(configPath);
    case "diagnose":
      if (nodeMajor() < MIN_NODE_MAJOR) throw new ConfigError(`Node ${MIN_NODE_MAJOR}+ required.`);
      await runDiagnose(receiptsDir ? resolve(receiptsDir) : null, label);
      return -1;
    case "check":
      return runCheck(configPath, explicitConfig, values.probe);
    case "print-config":
      if (!values.project) throw new ConfigError("print-config requires --project <dir>.");
      printConfig(
        values.project,
        label,
        values["receipts-dir"] ?? null,
        values.json,
        values["pilot-config"] ?? null,
      );
      return 0;
    case "receipts":
      if (!receiptsDir) throw new ConfigError("receipts requires --receipts-dir <dir>.");
      showReceipts(resolve(receiptsDir));
      return 0;
    case "--version":
    case "version":
      console.log(BUILD_COMMIT ? `${CONNECTOR_VERSION} (${BUILD_COMMIT})` : CONNECTOR_VERSION);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    // -1: a long-running server owns the process lifetime.
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[phonebook] error: ${message}\n`);
    process.exit(
      err instanceof ConfigError ||
        err instanceof SetupError ||
        (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
        ? 2
        : 1,
    );
  },
);
