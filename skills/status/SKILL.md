---
name: status
description: Show whether Phonebook is set up, connected, channel-verified and registered in this session.
disable-model-invocation: true
---

# Phonebook status

Observe only. Do not sign in, register, approve senders, pause/resume, or confirm a channel
challenge because of this command.

1. If the `mcp__plugin_phonebook_phonebook__set_availability` tool is available, call it once with
   `{"action": "status"}`. It reports this session's transport, channel readiness, registration,
   receiving preference and busy state.

2. For the local setup state, run with the Bash tool:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/runtime/phonebook.mjs" plugin-status --project "${CLAUDE_PROJECT_DIR}"
   ```

3. Summarize in a few lines, keeping these states distinct:
   - **not set up** or **signed out**: run `/phonebook:setup`, then start a new session with the
     printed command.
   - **standalone entry active**: the plugin connector is idle because the standalone connector
     is configured; `/phonebook:setup` can migrate this project.
   - **channel not verified**: Phonebook cannot deliver events to this session. Start Claude with
     the command `/phonebook:setup` printed (it loads the development channel).
   - **registered but paused**, **registered and receiving**, or **no registration** (asking still
     works without registering).
     Never print credential values or private file contents.
