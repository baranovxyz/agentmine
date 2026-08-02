import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_LINEAGE_BACKFILL_META_KEY,
  CODEX_TOKEN_USAGE_BACKFILL_META_KEY,
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
      expect(getMeta(db, "schema_version")).toBe("15");
      expect(getMeta(db, CODEX_LINEAGE_BACKFILL_META_KEY)).toBeUndefined();
      expect(getMeta(db, CODEX_TOKEN_USAGE_BACKFILL_META_KEY)).toBeUndefined();
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
      expect(getMeta(migrated, CODEX_TOKEN_USAGE_BACKFILL_META_KEY)).toBe("1");
      expect(getMeta(migrated, "schema_version")).toBe("15");
    } finally {
      migrated.close();
    }
  });

  it("invalidates cached Codex usage when upgrading from schema v14", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-token-migration-"));
    dirs.push(dir);
    const dbPath = join(dir, "sessions.db");
    const legacy = openDb({ path: dbPath });
    legacy
      .prepare(
        `INSERT INTO sessions (id, source, content_hash, input_tokens)
         VALUES ('cx--cached', 'codex', 'cached-hash', 999),
                ('cc--cached', 'claude-code', 'claude-hash', 111)`,
      )
      .run();
    upsertMeta(legacy, "schema_version", "14");
    legacy.close();

    const migrated = openDb({ path: dbPath });
    try {
      const rows = migrated
        .prepare<
          [],
          {
            id: string;
            content_hash: string | null;
            input_tokens: number | null;
          }
        >(`SELECT id, content_hash, input_tokens FROM sessions ORDER BY id`)
        .all();
      expect(rows).toEqual([
        {
          id: "cc--cached",
          content_hash: "claude-hash",
          input_tokens: 111,
        },
        { id: "cx--cached", content_hash: null, input_tokens: null },
      ]);
      expect(
        getMeta(migrated, CODEX_LINEAGE_BACKFILL_META_KEY),
      ).toBeUndefined();
      expect(getMeta(migrated, CODEX_TOKEN_USAGE_BACKFILL_META_KEY)).toBe("1");
      expect(getMeta(migrated, "schema_version")).toBe("15");
    } finally {
      migrated.close();
    }
  });

  it("treats partially numeric schema metadata as untrusted", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-invalid-version-"));
    dirs.push(dir);
    const dbPath = join(dir, "sessions.db");
    const legacy = openDb({ path: dbPath });
    legacy
      .prepare(
        `INSERT INTO sessions (id, source, content_hash, input_tokens)
         VALUES ('cx--invalid-version', 'codex', 'stale-hash', 999)`,
      )
      .run();
    upsertMeta(legacy, "schema_version", "15junk");
    legacy.close();

    const migrated = openDb({ path: dbPath });
    try {
      expect(
        migrated
          .prepare(
            `SELECT content_hash, input_tokens
               FROM sessions WHERE id = 'cx--invalid-version'`,
          )
          .get(),
      ).toEqual({ content_hash: null, input_tokens: null });
      expect(getMeta(migrated, CODEX_TOKEN_USAGE_BACKFILL_META_KEY)).toBe("1");
      expect(getMeta(migrated, "schema_version")).toBe("15");
    } finally {
      migrated.close();
    }
  });

  it("refuses a future schema before changing its journal mode or metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-future-version-"));
    dirs.push(dir);
    const dbPath = join(dir, "sessions.db");
    const future = new DatabaseSync(dbPath);
    future.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '16');
    `);
    future.close();

    expect(() => openDb({ readonly: true, init: false, path: dbPath })).toThrow(
      /schema version 16 is newer/u,
    );
    expect(() => openDb({ path: dbPath })).toThrow(
      /schema version 16 is newer/u,
    );

    const check = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      check
        .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
        .get(),
    ).toEqual({ value: "16" });
    expect(check.prepare(`PRAGMA journal_mode`).get()).toEqual({
      journal_mode: "delete",
    });
    check.close();
  });

  it("refuses an unsafe canonical future schema before mutation", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-unsafe-future-version-"));
    dirs.push(dir);
    const dbPath = join(dir, "sessions.db");
    const future = new DatabaseSync(dbPath);
    future.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value)
      VALUES ('schema_version', '999999999999999999999999');
    `);
    future.close();

    expect(() => openDb({ path: dbPath })).toThrow(
      /schema version .* is newer/u,
    );

    const check = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      check
        .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
        .get(),
    ).toEqual({ value: "999999999999999999999999" });
    expect(check.prepare(`PRAGMA journal_mode`).get()).toEqual({
      journal_mode: "delete",
    });
    check.close();
  });
});
