import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Instance-specific local status: several Claude sessions may share one
 * account config, so each running connector writes its own file
 * (<config dir>/status/<config name>.<pid>.json) and removes it on exit.
 */
export function statusDirFor(configPath: string): string {
  return join(dirname(configPath), "status");
}

export function statusFileFor(configPath: string, pid = process.pid): string {
  return join(statusDirFor(configPath), `${basename(configPath, ".json")}.${pid}.json`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Status files of live connectors for this config; stale ones are removed. */
export function liveStatusFiles(configPath: string): string[] {
  const dir = statusDirFor(configPath);
  const prefix = `${basename(configPath, ".json")}.`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const live: string[] = [];
  for (const name of names) {
    const m = /^(.*)\.(\d+)\.json$/.exec(name);
    if (!m || `${m[1]}.` !== prefix) continue;
    const file = join(dir, name);
    if (pidAlive(Number(m[2]))) live.push(file);
    else rmSync(file, { force: true });
  }
  return live;
}
