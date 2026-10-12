import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const RECEIPT_SCHEMA = "phonebook.channel-diagnostic.v1";

export const ReceiptSchema = z.object({
  schema: z.literal(RECEIPT_SCHEMA),
  label: z.string().nullable(),
  run_id: z.string(),
  outcome: z.enum(["pending", "verified", "expired", "failed", "unverified"]),
  started_at: z.string(),
  expires_at: z.string(),
  challenge_emissions: z.array(z.string()),
  confirmed_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  rejected_confirmations: z.number(),
  duplicate_confirmations: z.number(),
  versions: z.object({
    connector: z.string(),
    node: z.string(),
    mcp_sdk: z.string(),
    negotiated_protocol_version: z.string().nullable(),
    client: z.object({ name: z.string(), version: z.string() }).nullable(),
  }),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

/** Writes one receipt per run, atomically, readable only by the owner. */
export function writeReceipt(dir: string, receipt: Receipt): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${receipt.run_id}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

export function readReceipts(dir: string): Receipt[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Receipt[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = ReceiptSchema.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // ignore unreadable files
    }
  }
  return out.sort((a, b) => a.started_at.localeCompare(b.started_at));
}
