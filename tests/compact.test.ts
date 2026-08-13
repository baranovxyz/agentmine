import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import type { CanonicalSession } from "../src/adapters/types.js";
import {
  archiveAlias,
  archivePath,
  attachArchive,
  corpusLayout,
} from "../src/db/archives.js";
import { getMeta, openDb, upsertMeta } from "../src/db/client.js";
import { decodePayload } from "../src/db/payloadCodec.js";
import { upsertSession } from "../src/db/writer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);
const TSX_BIN = join(REPO, "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(REPO, "src", "cli.ts");
const CLI_TIMEOUT = 30_000;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-compact-"));
  dirs.push(dir);
  return join(dir, "sessions.db");
}

async function runCli(args: string[], dbPath: string) {
  return execa(TSX_BIN, [CLI_ENTRY, ...args], {
    cwd: REPO,
    reject: false,
    env: { ...process.env, NO_COLOR: "1", AGENTMINE_DB: dbPath },
  });
}

function session(id: string, seed: string): CanonicalSession {
  return {
    id,
    source: "claude-code",
    projectPath: "/tmp/proj",
    contentHash: randomUUID(),
    messages: [
      {
        turn: 1,
        role: "assistant",
        text: "",
        toolCalls: [
          {
            name: "Bash",
            args: { command: "echo" },
            argsHash: `h-${seed}`,
            argsPreview: "echo",
            outputPreview: "out",
            outputFull: `full output for ${seed} `.repeat(40),
            exitCode: 0,
          },
        ],
      },
    ],
    rawEvents: [
      {
        seq: 0,
        eventType: "user",
        ts: 1,
        rawJson: `{"type":"user","s":"${seed}"}`,
      },
      {
        seq: 1,
        eventType: "assistant",
        ts: 2,
        rawJson: `{"type":"assistant","body":"${"x".repeat(200)}","s":"${seed}"}`,
      },
    ],
  };
}

/**
 * Build a corpus in the PRE-split layout: hot payload tables present and
 * populated, exactly as a corpus written before the split layout looks.
 */
function makePreSplitCorpus(dbPath: string, ids: string[]): void {
  const db = openDb({ path: dbPath });
  db.execBatch(`
    CREATE TABLE IF NOT EXISTS tool_outputs (
      session_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      output_text TEXT NOT NULL,
      PRIMARY KEY(session_id, turn, idx)
    );
    CREATE TABLE IF NOT EXISTS raw_events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      source TEXT NOT NULL,
      event_type TEXT,
      ts INTEGER,
      raw_json TEXT NOT NULL,
      PRIMARY KEY(session_id, seq)
    );
  `);
  const insertRaw = db.prepare(
    `INSERT INTO raw_events (session_id, seq, source, event_type, ts, raw_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertOut = db.prepare(
    `INSERT INTO tool_outputs (session_id, turn, idx, output_text) VALUES (?, ?, ?, ?)`,
  );
  for (const id of ids) {
    const s = session(id, id);
    upsertSession(db, s);
    // Clear the counters upsertSession wrote: a pre-split corpus has none.
    db.prepare(
      `UPDATE sessions SET raw_event_count = NULL, tool_output_count = NULL WHERE id = ?`,
    ).run(id);
    for (const ev of s.rawEvents ?? []) {
      insertRaw.run(id, ev.seq, s.source, ev.eventType, ev.ts, ev.rawJson);
    }
    for (const msg of s.messages) {
      msg.toolCalls.forEach((tc, idx) => {
        if (tc.outputFull !== undefined) {
          insertOut.run(id, msg.turn, idx, tc.outputFull);
        }
      });
    }
  }
  expect(corpusLayout(db)).toBe("pre-split");
  db.close();
}

describe("agentmine compact", () => {
  it(
    "reports a plan and writes nothing on --dry-run",
    async () => {
      const dbPath = tmpDb();
      makePreSplitCorpus(dbPath, ["s-a", "s-b"]);
      const sizeBefore = statSync(dbPath).size;

      const { exitCode, stdout } = await runCli(
        ["compact", "--dry-run"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("success");
      expect(parsed.data.dry_run).toBe(true);
      expect(parsed.data.status).toBe("planned");
      expect(parsed.data.layout).toBe("pre-split");
      expect(parsed.data.estimate.raw_events.rows).toBe(4);
      expect(parsed.data.estimate.tool_outputs.rows).toBe(2);
      expect(parsed.data.space.required_bytes).toBeGreaterThan(0);

      // Nothing written: no archives, hot database untouched.
      expect(existsSync(archivePath("raw", dbPath))).toBe(false);
      expect(existsSync(archivePath("tools", dbPath))).toBe(false);
      expect(statSync(dbPath).size).toBe(sizeBefore);
      const db = openDb({
        path: dbPath,
        init: false,
        allowPreSplit: true,
      });
      expect(corpusLayout(db)).toBe("pre-split");
      db.close();
    },
    CLI_TIMEOUT,
  );

  it(
    "relocates payload losslessly, drops the hot tables, and reclaims space",
    async () => {
      const dbPath = tmpDb();
      const ids = ["s-a", "s-b", "s-c"];
      makePreSplitCorpus(dbPath, ids);
      const sizeBefore = statSync(dbPath).size;

      const { exitCode, stdout } = await runCli(["compact"], dbPath);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.data.status).toBe("completed");
      expect(parsed.data.moved_sessions).toBe(ids.length);
      expect(parsed.data.bytes_after.hot_db).toBeLessThanOrEqual(sizeBefore);

      const db = openDb({ path: dbPath, init: false });
      expect(corpusLayout(db)).toBe("split");
      attachArchive(db, "raw");
      attachArchive(db, "tools");

      // Every event round-trips to the exact original bytes.
      for (const id of ids) {
        const expected = session(id, id);
        const rows = db
          .prepare<[string], { seq: number; payload: Uint8Array }>(
            `SELECT seq, payload FROM ${archiveAlias("raw")}.raw_events
              WHERE session_id = ? ORDER BY seq`,
          )
          .all(id);
        expect(rows.map((r) => decodePayload(r.payload))).toEqual(
          (expected.rawEvents ?? []).map((e) => e.rawJson),
        );

        const out = db
          .prepare<[string], { payload: Uint8Array }>(
            `SELECT payload FROM ${archiveAlias("tools")}.tool_outputs
              WHERE session_id = ?`,
          )
          .get(id);
        expect(out).toBeDefined();
        if (out) {
          expect(decodePayload(out.payload)).toBe(
            expected.messages[0]?.toolCalls[0]?.outputFull,
          );
        }
      }

      // Counters were backfilled so `stats` never opens an archive.
      const totals = db
        .prepare<[], { raw: number; outs: number }>(
          `SELECT SUM(raw_event_count) AS raw, SUM(tool_output_count) AS outs FROM sessions`,
        )
        .get();
      expect(totals).toEqual({ raw: 6, outs: 3 });
      db.close();
    },
    CLI_TIMEOUT,
  );

  it(
    "resumes from its watermark instead of restarting",
    async () => {
      const dbPath = tmpDb();
      makePreSplitCorpus(dbPath, ["s-a", "s-b", "s-c"]);

      // Simulate an interrupted run that already relocated the first session.
      const seed = openDb({
        path: dbPath,
        init: false,
        allowPreSplit: true,
      });
      upsertMeta(seed, "compact_watermark", "s-a");
      seed.close();

      const { exitCode, stdout } = await runCli(["compact"], dbPath);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.data.status).toBe("resumed");
      expect(parsed.data.resumed_from_session).toBe("s-a");
      // Only the two sessions after the watermark were re-relocated.
      expect(parsed.data.moved_sessions).toBe(2);

      const db = openDb({ path: dbPath, init: false });
      expect(corpusLayout(db)).toBe("split");
      attachArchive(db, "raw");
      // The skipped session's payload is still preserved: dropping the hot
      // tables sweeps anything the watermark claimed was already done.
      const total = db
        .prepare<[], { n: number }>(
          `SELECT COUNT(*) AS n FROM ${archiveAlias("raw")}.raw_events`,
        )
        .get();
      expect(total?.n).toBe(6);
      expect(getMeta(db, "compact_watermark")).toBe("");
      db.close();
    },
    CLI_TIMEOUT,
  );

  it(
    "is a no-op on an already-split corpus",
    async () => {
      const dbPath = tmpDb();
      const db = openDb({ path: dbPath });
      expect(corpusLayout(db)).toBe("split");
      db.close();

      const { exitCode, stdout } = await runCli(["compact"], dbPath);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.trim()).data.status).toBe("already-split");
    },
    CLI_TIMEOUT,
  );

  it(
    "reclaims space on an already-split corpus whose VACUUM never completed",
    async () => {
      const dbPath = tmpDb();
      const db = openDb({ path: dbPath });
      // A split corpus carrying a large free list is exactly what a VACUUM
      // that died (typically out of disk) leaves behind: the payload tables
      // were already dropped, so the relocation pass has nothing to do.
      const insert = db.prepare(
        `INSERT INTO messages (session_id, turn, role, text) VALUES (?, ?, ?, ?)`,
      );
      const fill = db.transaction(() => {
        for (let i = 0; i < 4000; i += 1) {
          insert.run("bloat", i, "user", "x".repeat(1500));
        }
      });
      fill();
      db.prepare(`DELETE FROM messages WHERE session_id = 'bloat'`).run();
      const freeRatio =
        Number(db.pragma("freelist_count", { simple: true })) /
        Number(db.pragma("page_count", { simple: true }));
      expect(freeRatio).toBeGreaterThan(0.1);
      const bloatedSize = statSync(dbPath).size;
      db.close();

      const { exitCode, stdout } = await runCli(["compact"], dbPath);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.data.status).toBe("already-split");
      expect(parsed.data.bytes_after.hot_db).toBeLessThan(bloatedSize);
      expect(statSync(dbPath).size).toBeLessThan(bloatedSize);
    },
    CLI_TIMEOUT,
  );

  it(
    "requires compaction before every normal corpus command",
    async () => {
      const dbPath = tmpDb();
      makePreSplitCorpus(dbPath, ["s-a"]);
      const commands = [
        ["stats"],
        ["sessions"],
        ["query", "SELECT 1"],
        ["schema", "--tables"],
        ["sync", "--dry-run", "--source", "codex"],
        ["ingest", "--source", "codex"],
        ["normalize", "--dry-run"],
        ["extract"],
        ["purge", "--project-path-allow", "/tmp/proj"],
      ];
      for (const command of commands) {
        const { exitCode, stdout } = await runCli(command, dbPath);
        expect(exitCode, command.join(" ")).toBe(2);
        const parsed = JSON.parse(stdout.trim());
        expect(parsed.status).toBe("error");
        expect(parsed.errors[0]).toMatchObject({
          name: "COMPACTION_REQUIRED",
          category: "user",
          retryable: false,
          path: dbPath,
        });
        expect(parsed.errors[0].message).toContain(
          "agentmine compact --dry-run",
        );
      }
    },
    CLI_TIMEOUT,
  );
});
