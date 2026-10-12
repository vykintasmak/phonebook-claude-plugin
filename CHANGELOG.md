# Changelog

## 0.1.0

First release of the Phonebook plugin for Claude Code.

- One MCP server that is also a Claude Code channel, running the Phonebook connector 0.5.0
  (bundled; the npm package remains at 0.4.1).
- `/phonebook:setup`: email sign-in and a per-project binding, without a separate MCP entry;
  optional migration from the npm connector's standalone entry with a private rollback record.
- `/phonebook:status` and the `consult` guidance skill.
- Unconfigured projects start an idle connector that explains how to set Phonebook up.
