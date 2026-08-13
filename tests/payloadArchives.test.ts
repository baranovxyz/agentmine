import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveAlias,
  archiveExists,
  archivePath,
  attachArchive,
  detachArchive,
  isAttached,
} from "../src/db/archives.js";
import { openDb } from "../src/db/client.js";
import {
  decodePayload,
  encodePayload,
  payloadCodecAvailable,
} from "../src/db/payloadCodec.js";

const workDirs: string[] = [];

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-archives-"));
  workDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of workDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("payload codec", () => {
  it("is available on this runtime", () => {
    expect(payloadCodecAvailable()).toBe(true);
  });

  it("round-trips compressible payload byte-identically", () => {
    const text = JSON.stringify({
      type: "assistant",
      message: { content: "the quick brown fox ".repeat(500) },
    });
    const encoded = encodePayload(text);
    expect(encoded.byteLength).toBeLessThan(Buffer.byteLength(text));
    expect(decodePayload(encoded)).toBe(text);
  });

  it("round-trips payload that does not compress, without inflating it", () => {
    const text = "{}";
    const encoded = encodePayload(text);
    // Frame header only; a zstd frame would be larger than the input here.
    expect(encoded.byteLength).toBe(Buffer.byteLength(text) + 1);
    expect(decodePayload(encoded)).toBe(text);
  });

  it("preserves non-ASCII payload exactly", () => {
    const text = JSON.stringify({ text: "проверка — 日本語 — 🙂", n: 1 });
    expect(decodePayload(encodePayload(text))).toBe(text);
  });

  it("rejects an unknown encoding frame instead of returning garbage", () => {
    const bogus = new Uint8Array([0x7f, 1, 2, 3]);
    expect(() => decodePayload(bogus)).toThrow(/unknown encoding tag/u);
  });

  it("rejects an empty blob", () => {
    expect(() => decodePayload(new Uint8Array())).toThrow(
      /carries no encoding frame/u,
    );
  });
});

describe("archive location", () => {
  it("derives sibling paths from the hot database path", () => {
    const raw = archivePath("raw", "/corpus/sessions.db");
    const tools = archivePath("tools", "/corpus/sessions.db");
    expect(raw).toBe("/corpus/sessions-raw.db");
    expect(tools).toBe("/corpus/sessions-tools.db");
  });

  it("follows a relocated hot database rather than a fixed location", () => {
    expect(archivePath("raw", "/elsewhere/other.db")).toBe(
      "/elsewhere/other-raw.db",
    );
  });
});

describe("archive attachment", () => {
  it("creates the archive file and schema on demand", () => {
    const dir = workDir();
    const dbPath = join(dir, "sessions.db");
    const db = openDb({ path: dbPath });
    try {
      expect(archiveExists("raw", dbPath)).toBe(false);
      const alias = attachArchive(db, "raw", { create: true, dbPath });
      expect(alias).toBe(archiveAlias("raw"));
      expect(archiveExists("raw", dbPath)).toBe(true);
      db.prepare(
        `INSERT INTO ${alias}.raw_events (session_id, seq, source, event_type, ts, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("s1", 0, "claude-code", "user", 1, encodePayload('{"a":1}'));
      const row = db
        .prepare<[], { payload: Uint8Array }>(
          `SELECT payload FROM ${alias}.raw_events`,
        )
        .get();
      expect(row).toBeDefined();
      if (row) expect(decodePayload(row.payload)).toBe('{"a":1}');
    } finally {
      db.close();
    }
  });

  it("refuses to attach a missing archive without create, naming the recovery command", () => {
    const dir = workDir();
    const dbPath = join(dir, "sessions.db");
    const db = openDb({ path: dbPath });
    try {
      expect(() => attachArchive(db, "tools", { dbPath })).toThrow(
        /agentmine compact/u,
      );
    } finally {
      db.close();
    }
  });

  it("is idempotent and detachable", () => {
    const dir = workDir();
    const dbPath = join(dir, "sessions.db");
    const db = openDb({ path: dbPath });
    try {
      attachArchive(db, "tools", { create: true, dbPath });
      attachArchive(db, "tools", { create: true, dbPath });
      expect(isAttached(db, archiveAlias("tools"))).toBe(true);
      detachArchive(db, "tools");
      expect(isAttached(db, archiveAlias("tools"))).toBe(false);
      detachArchive(db, "tools");
    } finally {
      db.close();
    }
  });

  it("leaves the hot database usable when no archive exists", () => {
    const dir = workDir();
    const dbPath = join(dir, "sessions.db");
    const db = openDb({ path: dbPath });
    try {
      const row = db
        .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM sessions`)
        .get();
      expect(row?.n).toBe(0);
      expect(existsSync(archivePath("raw", dbPath))).toBe(false);
      expect(existsSync(archivePath("tools", dbPath))).toBe(false);
    } finally {
      db.close();
    }
  });
});
