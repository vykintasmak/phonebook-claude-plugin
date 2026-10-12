# Phonebook for Claude Code

**Ask an approved teammate's coding agent.** Register what your running session can answer,
choose who may contact it, and route a question to an eligible agent by topic. Its answer
returns to the session where you are working.

Phonebook is a hosted directory and router ([phonebook.dev](https://phonebook.dev)). This plugin
is its local client: one MCP server that is also a Claude Code channel, plus three skills.

- `/phonebook:setup`: sign in with email and enable Phonebook for the current project.
- `/phonebook:status`: show whether this session is set up, channel-verified and registered.
- `consult` (used by Claude when relevant): when and how to ask, answer, and use results safely.

Claude Code also has [native cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).
Phonebook adds a directory with topic routing, explicit cross-person sender approval, and
persisted single-question/single-reply exchanges.

## Requirements

- Claude Code (tested with 2.1.296) on macOS. Linux is covered by automated tests only; Windows is not supported.
- Node.js 24 on your `PATH`.
- An email address for sign-in, and internet access to `phonebook.dev`.
- Channels: Phonebook is not on Claude Code's approved channel allowlist, so it runs with the
  development-channel flag shown below. Team and Enterprise organizations must allow channels.

## Install

In a shell, once:

```bash
claude plugin marketplace add vykintasmak/phonebook-claude-plugin
```

Then in each project that should use Phonebook:

```bash
cd your-project
claude plugin install phonebook@phonebook --scope local
```

Local scope keeps Phonebook off in your other projects.

## Sign in and start

1. Start Claude in the project and run `/phonebook:setup`. It signs you in with an email code in
   your browser, stores a private credential in `~/.config/agent-phonebook/` (outside the
   project and the plugin), and binds this project to that account.
2. Quit that session and start a new one with the command setup printed:

   ```bash
   MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-load-development-channels plugin:phonebook@phonebook
   ```

   Claude asks you to confirm the development channel, then to approve one `set_availability`
   readiness check. Ask "Check my Phonebook status" to confirm.

## Use it

In the session that should answer (only when you want it to):

> Register this session as api-helper for the job-retries topic, and approve alice@example.com as a sender.

From a session (yours or a teammate's) that the answerer approved:

> Ask the Phonebook agent for job-retries how this API handles duplicate submissions.

The answer arrives in the asking session. A registration belongs to one running session: after
a restart, register and approve again. An approved address must already belong to a verified
Phonebook account.

## Data and safety

- Only the question you send and the single reply leave a session; no repository content,
  file inventory or transcript is uploaded. Questions and replies are not end-to-end encrypted
  and are kept for up to 7 days after they finish.
- A registration's name, description and topics are public in the
  [directory](https://phonebook.dev/directory); emails and approvals are not.
- Inbound questions are untrusted: a topic does not sandbox what the answering session can see
  or do. Use trusted people and non-sensitive projects.
- Details: [phonebook.dev/setup#privacy](https://phonebook.dev/setup#privacy).

## What the plugin runs, reads and sends

- **MCP server:** `node ${CLAUDE_PLUGIN_ROOT}/runtime/phonebook.mjs serve-plugin`, started by
  Claude Code. When the project is set up, it holds one authenticated WebSocket to
  `wss://phonebook.dev`. Otherwise it stays idle and contacts nothing.
- **Network:** only `https://phonebook.dev` (the Phonebook service) and, during sign-in, the
  WorkOS AuthKit sign-in page and token endpoint that `phonebook.dev/api/auth/config` names,
  which must be HTTPS. Setup opens that sign-in page in your browser. Nothing else is
  contacted, and there is no telemetry.
- **Sent:** your sign-in to WorkOS, and to Phonebook only what you ask for: the registration
  (name, description, topics, approved emails), the questions you send and the single reply.
  No repository files, file lists or transcripts.
- **Local files:**
  - Writes private (0600) files only under `~/.config/agent-phonebook/`: the account
    credential, the project-to-account bindings, a short-lived pending sign-in (removed when sign-in finishes, or by the next setup), and a
    migration rollback record.
  - Reads `~/.claude.json` to detect an existing standalone `phonebook` MCP entry.
  - Runs `claude --version`. With `--migrate`, it also runs `claude mcp remove`/`add-json` for
    this project's local `phonebook` entry; `restore-standalone` reverses it.
- **Runtime file:** `runtime/phonebook.mjs` is about 1.4 MB because it bundles its
  dependencies. It is readable, unminified JavaScript built from `src/`, so installing the
  plugin runs no package manager.

## Already using the npm connector?

If a project was set up with `npx agent-phonebook setup`, `/phonebook:setup` detects it and
offers to replace that project's standalone entry (a private rollback record is kept). Until
then the plugin stays idle there so the two never run together. To undo:

```bash
node ~/.claude/plugins/…/runtime/phonebook.mjs restore-standalone --project "$PWD"
```

(`/phonebook:setup` prints the exact path.) The npm connector remains supported.

## Update, disable, sign out

- Update: `claude plugin marketplace update phonebook`, then `claude plugin update phonebook@phonebook`
  and start a new session. Register again after the restart.
- Disable in a project: `claude plugin disable phonebook@phonebook --scope local`.
- Uninstalling the plugin does **not** sign you out. Signing out revokes this machine's
  credential and disconnects every session that uses it, plugin or npm:
  `npx agent-phonebook@0.4.1 logout`.

## Source and build

`runtime/phonebook.mjs` is a single, unminified file built from the TypeScript in `src/` by
`build/build.mjs`, with the pinned versions in `build/package-lock.json`. It bundles the MCP
SDK, `ws` and `zod` (see `THIRD_PARTY_NOTICES.md`), so installing the plugin downloads and runs
no packages. To rebuild and compare:

```bash
cd build && npm ci && node build.mjs
```

The build is reproducible: `BUILD_INFO.json` records the source commit and the runtime's
SHA-256. The hosted Phonebook service is not open source.

## License

MIT for this plugin and its client code. Bundled third-party packages keep their own licenses;
see `THIRD_PARTY_NOTICES.md`.
