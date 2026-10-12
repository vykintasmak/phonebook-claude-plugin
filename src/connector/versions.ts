import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(startFile: string, expectedName: string): string {
  let dir = dirname(startFile);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === expectedName && pkg.version) return pkg.version;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return "unknown";
    dir = parent;
  }
}

/** Injected by scripts/package-connector.mjs into the standalone bundle. */
declare const __PHONEBOOK_BUILD__: { version: string; mcpSdk: string; commit: string } | undefined;
const BUILD = typeof __PHONEBOOK_BUILD__ !== "undefined" ? __PHONEBOOK_BUILD__ : null;

export const CONNECTOR_VERSION =
  BUILD?.version ??
  readPackageVersion(fileURLToPath(import.meta.url), "@agent-phonebook/connector");

export const MCP_SDK_VERSION =
  BUILD?.mcpSdk ??
  (() => {
    try {
      return readPackageVersion(
        fileURLToPath(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js")),
        "@modelcontextprotocol/sdk",
      );
    } catch {
      return "unknown";
    }
  })();

/** Source commit of a packaged build; null when running from the workspace. */
export const BUILD_COMMIT: string | null = BUILD?.commit ?? null;
