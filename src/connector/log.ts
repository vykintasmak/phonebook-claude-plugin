export type Log = (message: string) => void;

/** Diagnostics go to stderr only (stdout is MCP traffic), with secrets redacted. */
export const stderrLog: Log = (message) =>
  process.stderr.write(
    `[phonebook] ${message.replace(/pb[pa]_[A-Za-z0-9_.-]+/g, "pb*_[redacted]")}\n`,
  );
