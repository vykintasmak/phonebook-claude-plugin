---
name: setup
description: Sign in to Phonebook with email and enable it for this project. Run only when the user asks.
disable-model-invocation: true
---

# Set up Phonebook for this project

The user asked to set up Phonebook. Setup signs in with email (no GitHub), stores a private
per-installation credential outside this repository, and binds **this project only** to that
account. It does not register an answering agent, approve senders, or upload repository content.

1. Check the prerequisite with the Bash tool: `node --version`. Phonebook needs Node.js 24. If it
   is missing or older, explain that and stop. Do not install or replace runtimes.

2. Run setup with the Bash tool, exactly:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/runtime/phonebook.mjs" setup-plugin --yes --no-wait --project "${CLAUDE_PROJECT_DIR}"
   ```

   Never ask the user to paste a code, token, or file contents into the chat.

3. Read the exit status:
   - **5**: sign-in started and a browser page opened. Show the user the confirmation code and
     the sign-in link exactly as printed, and the account setup expects if it named one. Tell them:
     check that the browser page shows the same code, then sign in there with that email and the code that is emailed to them (in the
     browser, never in this chat). Then, in the same turn, run with a 600000 ms timeout:

     ```
     node "${CLAUDE_PLUGIN_ROOT}/runtime/phonebook.mjs" setup-plugin --finish --project "${CLAUDE_PROJECT_DIR}"
     ```

     and read its exit status with these same rules.

   - **0**: relay the "Bound" line and the launch command it printed. Tell the user to quit this
     Claude session and start a new one with that exact command from a terminal. Phonebook
     activates only in a new session; do not try to restart Claude yourself.
   - **4**: one or more accounts (shown masked) are already signed in on this machine and this
     project has no Phonebook account yet. Ask the user which to use for this project, or whether
     to sign in with a different email. Then run the step 2 command with `--use-existing` (the one
     existing account), `--account <their email>` (one of several; ask them to type it), or
     `--switch-account`, exactly as they chose. Never pick for them.
   - **3**: this project already uses the standalone Phonebook MCP entry. Explain that both would
     start, and ask the user whether to replace this project's standalone entry with the plugin
     (a private rollback record is kept; nothing else in their settings changes). Only if they
     explicitly agree, run the step 2 command with `--migrate` added.
   - **6**: the browser signed in as a different account than this project uses, so nothing was
     changed. Relay the message. Suggest signing out on the Phonebook sign-in page or using a
     private browser window, then running `/phonebook:setup` again. Use `--switch-account` only if
     the user says the new account should be this project's account.
   - **anything else**: relay the error message as printed and stop. Do not retry in a loop.

4. Mention the next steps after the restart: ask "Check my Phonebook status", then register this
   session only if the user wants it to answer questions, and only for senders they name.

Other accounts: to use a different email for this project, add `--switch-account`; to pick an
existing signed-in account, add `--account <email>`. Undo a migration with
`node "${CLAUDE_PLUGIN_ROOT}/runtime/phonebook.mjs" restore-standalone --project "${CLAUDE_PROJECT_DIR}"`.
