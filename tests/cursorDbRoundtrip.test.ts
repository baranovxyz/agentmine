import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCursorFile } from "../src/adapters/canonical.js";
import { openDb } from "../src/db/client.js";
import { upsertSession } from "../src/db/writer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, "fixtures", "cursor", "Users-u-repo");
const PARENT_UUID = "sess0001-aaaa-bbbb-cccc-dddddddddddd";
const TOP = join(FIXTURE_DIR, PARENT_UUID, `${PARENT_UUID}.jsonl`);

// DB-layer counterpart of the parser tests that moved to agent-canonical:
// a parsed cursor session (the only dialect filling messageParts) must
// round-trip its lossless tier through upsertSession.
describe("cursor session DB round-trip", () => {
  it("writes raw events and message parts to SQLite", async () => {
    const session = await parseCursorFile(TOP);
    if (!session) throw new Error("no session");

    const dir = mkdtempSync(join(tmpdir(), "agentmine-cursor-parts-"));
    const db = openDb({ path: join(dir, "test.db") });
    try {
      upsertSession(db, session);
      const raw = db
        .prepare<[string], { n: number }>(
          `SELECT count(*) AS n FROM raw_events WHERE session_id = ?`,
        )
        .get(session.id);
      const parts = db
        .prepare<[string], { n: number }>(
          `SELECT count(*) AS n FROM message_parts WHERE session_id = ?`,
        )
        .get(session.id);
      const image = db
        .prepare<[string], { payload_json: string }>(
          `SELECT payload_json FROM message_parts WHERE session_id = ? AND part_type = 'image'`,
        )
        .get(session.id);

      expect(raw?.n).toBe(7);
      expect(parts?.n).toBe(10);
      expect(image?.payload_json).toContain("redacted");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
