import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_LINEAGE_BACKFILL_META_KEY,
  getMeta,
  openDb,
  upsertMeta,
} from "../src/db/client.js";
import { sessionIsUpToDate } from "../src/db/writer.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Agentmine data migrations", () => {
  it("does not schedule a legacy Codex backfill for a fresh database", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-fresh-migration-"));
    dirs.push(dir);
    const db = openDb({ path: join(dir, "sessions.db") });
    try {
      expect(getMeta(db, "schema_version")).toBe("14");
      expect(getMeta(db, CODEX_LINEAGE_BACKFILL_META_KEY)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("invalidates Codex caches and clears legacy agent types from flat roots", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-migration-"));
    dirs.push(dir);
    const dbPath = join(dir, "sessions.db");
    const legacy = openDb({ path: dbPath });
    legacy
      .prepare(
        `INSERT INTO sessions
           (id, source, parent_session_id, agent_type, content_hash)
         VALUES
           ('cx--root', 'codex', NULL, 'codex-tui', 'root-hash'),
           ('cx--flat-child', 'codex', NULL, 'codex-tui', 'flat-child-hash'),
           ('cx--linked-child', 'codex', 'cx--root', '/root/audit', 'linked-child-hash'),
           ('cc--root', 'claude-code', NULL, 'guardian', 'claude-hash')`,
      )
      .run();
    upsertMeta(legacy, "schema_version", "13");
    legacy.close();

    const migrated = openDb({ path: dbPath });
    try {
      const rows = migrated
        .prepare<
          [],
          { id: string; agent_type: string | null; content_hash: string | null }
        >(`SELECT id, agent_type, content_hash FROM sessions ORDER BY id`)
        .all();
      expect(rows).toEqual([
        {
          id: "cc--root",
          agent_type: "guardian",
          content_hash: "claude-hash",
        },
        {
          id: "cx--flat-child",
          agent_type: null,
          content_hash: null,
        },
        {
          id: "cx--linked-child",
          agent_type: "/root/audit",
          content_hash: null,
        },
        { id: "cx--root", agent_type: null, content_hash: null },
      ]);
      expect(
        sessionIsUpToDate(migrated, "cx--flat-child", "flat-child-hash"),
      ).toBe(false);
      expect(sessionIsUpToDate(migrated, "cc--root", "claude-hash")).toBe(true);
      expect(getMeta(migrated, CODEX_LINEAGE_BACKFILL_META_KEY)).toBe("1");
      expect(getMeta(migrated, "schema_version")).toBe("14");
    } finally {
      migrated.close();
    }
  });
});
