// Builds runtime/phonebook.mjs (one file, no runtime dependencies) and
// THIRD_PARTY_NOTICES.md from src/ with the pinned versions in build/package-lock.json.
//   cd build && npm ci && node build.mjs
// The build manifest lives in build/, not the plugin root, so installing the plugin
// never installs these build-only packages.
// Same inputs give the same bytes; BUILD_INFO.json records the expected SHA-256.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const meta = JSON.parse(readFileSync(join(root, "build-meta.json"), "utf8"));
const sdk = JSON.parse(
  readFileSync(join(here, "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "utf8"),
).version;

mkdirSync(join(root, "runtime"), { recursive: true });
const result = await build({
  absWorkingDir: root,
  nodePaths: [join(here, "node_modules")],
  entryPoints: ["src/connector/cli.ts"],
  outfile: "runtime/phonebook.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // ws optional native accelerators are loaded inside try/catch.
  external: ["bufferutil", "utf-8-validate"],
  alias: { "@agent-phonebook/protocol": "./src/protocol/index.ts" },
  banner: {
    js: [
      `// Phonebook Claude Code plugin ${meta.plugin_version}: connector ${meta.connector_version} (${meta.source_commit}). MIT. Bundled; see THIRD_PARTY_NOTICES.md.`,
      'import { createRequire as __pbCreateRequire } from "node:module";',
      "const require = __pbCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: {
    __PHONEBOOK_BUILD__: JSON.stringify({
      version: meta.connector_version,
      mcpSdk: sdk,
      commit: meta.source_commit,
    }),
  },
  legalComments: "none",
  sourcemap: false,
  minify: false,
  metafile: true,
  logLevel: "warning",
});

// Third-party notices from the actual bundle inputs.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.split(/[\\/]/);
  const i = parts.lastIndexOf("node_modules");
  if (i < 0) continue;
  const name = parts[i + 1].startsWith("@") ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1];
  if (!packages.has(name))
    packages.set(name, join(root, ...parts.slice(0, i + 1 + name.split("/").length)));
}
const notices = [
  "# Third-party notices",
  "",
  "runtime/phonebook.mjs bundles these open-source packages:",
  "",
];
for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const license = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE"]
    .map((f) => join(dir, f))
    .find(existsSync);
  notices.push(`## ${name}@${pkg.version} (${pkg.license ?? "see below"})`, "");
  notices.push(
    license ? readFileSync(license, "utf8").trim() : "(no license file shipped by this package)",
    "",
  );
}
writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), `${notices.join("\n")}\n`);
const sha = createHash("sha256")
  .update(readFileSync(join(root, "runtime", "phonebook.mjs")))
  .digest("hex");
console.log(`runtime/phonebook.mjs sha256 ${sha}`);
