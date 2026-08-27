import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FTS_MATCH_SNIPPET_SQL,
  MAX_FTS_SNIPPET_CHARS,
  planFtsQuery,
} from "../src/commands/similar.js";
import { openDb } from "../src/db/client.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function corpusWithMessages(texts: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-similar-plan-"));
  tempDirs.push(dir);
  const db = openDb({ path: join(dir, "sessions.db") });
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, source) VALUES (?, 'codex')`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages (session_id, turn, role, text)
     VALUES (?, 1, 'user', ?)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO messages_fts (session_id, turn, text) VALUES (?, 1, ?)`,
  );
  texts.forEach((text, index) => {
    const id = `session-${index}`;
    insertSession.run(id);
    insertMessage.run(id, text);
    insertFts.run(id, text);
  });
  return db;
}

describe("similar FTS query planning", () => {
  it("keeps the rarest matching terms within a bounded posting budget", () => {
    const db = corpusWithMessages([
      "common specific needle",
      "common specific",
      "common",
      "common",
      "common",
      "common",
    ]);
    try {
      expect(
        planFtsQuery(db, "common specific absent needle", {
          maxMatchTerms: 3,
          maxPostings: 3,
        }),
      ).toBe('"specific" OR "needle"');
    } finally {
      db.close();
    }
  });

  it("keeps one matching term when every term exceeds the budget", () => {
    const db = corpusWithMessages([
      "common specific",
      "common specific",
      "common",
    ]);
    try {
      expect(
        planFtsQuery(db, "common specific", {
          maxPostings: 1,
        }),
      ).toBe('"specific"');
    } finally {
      db.close();
    }
  });

  it("returns a valid no-match query without scanning every input term", () => {
    const db = corpusWithMessages(["known words"]);
    try {
      expect(
        planFtsQuery(db, "missing absent ignored", {
          maxCandidateTerms: 2,
        }),
      ).toBe('"missing"');
    } finally {
      db.close();
    }
  });

  it("falls back to direct FTS counts before the vocabulary migration", () => {
    const db = corpusWithMessages(["common needle", "common", "common"]);
    try {
      db.execBatch(`DROP TABLE messages_fts_vocab`);
      expect(
        planFtsQuery(db, "common needle", {
          maxPostings: 1,
        }),
      ).toBe('"needle"');
    } finally {
      db.close();
    }
  });

  it("falls back to MATCH when tokenizer normalization changes the vocabulary spelling", () => {
    const db = corpusWithMessages(["café common", "common", "common"]);
    try {
      expect(
        planFtsQuery(db, "common café", {
          maxPostings: 1,
        }),
      ).toBe('"café"');
    } finally {
      db.close();
    }
  });

  it("pushes row identity into the FTS detail lookup", () => {
    const db = corpusWithMessages(["common needle", "common", "common"]);
    try {
      const first = db
        .prepare<[], { rowid: number }>(
          "SELECT rowid FROM messages_fts ORDER BY rowid LIMIT 1",
        )
        .get();
      if (first === undefined) throw new Error("expected an FTS row");
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${FTS_MATCH_SNIPPET_SQL}`)
        .all(MAX_FTS_SNIPPET_CHARS, first.rowid, '"common"') as Array<{
        detail: string;
      }>;

      expect(
        plan.some((step) => step.detail.includes("VIRTUAL TABLE INDEX 0:=M3")),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("caps a pathological single-token FTS snippet", () => {
    const db = corpusWithMessages([`needle ${"x".repeat(1_000_000)}`]);
    try {
      const first = db
        .prepare<[], { rowid: number }>(
          "SELECT rowid FROM messages_fts ORDER BY rowid LIMIT 1",
        )
        .get();
      if (first === undefined) throw new Error("expected an FTS row");

      const row = db
        .prepare<[number, number, string], { snippet: string }>(
          FTS_MATCH_SNIPPET_SQL,
        )
        .get(MAX_FTS_SNIPPET_CHARS, first.rowid, '"needle"');

      expect(row?.snippet.length).toBe(MAX_FTS_SNIPPET_CHARS);
    } finally {
      db.close();
    }
  });
});
