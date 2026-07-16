import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/db/sqlite.js";

// Unit tests for the node:sqlite compatibility shim. They pin the behaviors
// that differ from better-sqlite3 and that the shim normalizes: lone-array
// binds, named-parameter objects, savepoint-based nested transactions,
// `pragma({ simple })`, multi-statement batches, and online backup.

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentmine-sqlite-shim-"));
  db = new Database(join(dir, "test.db"));
  db.execBatch(`
    CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT UNIQUE, v INTEGER);
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("node:sqlite shim", () => {
  it("runs positional get/all/run and reports changes", () => {
    const res = db
      .prepare<[string, number], never>(`INSERT INTO t (k, v) VALUES (?, ?)`)
      .run("a", 1);
    expect(res.changes).toBe(1);
    expect(Number(res.lastInsertRowid)).toBeGreaterThan(0);

    const row = db
      .prepare<[string], { v: number }>(`SELECT v FROM t WHERE k = ?`)
      .get("a");
    expect(row).toEqual({ v: 1 });

    const all = db.prepare<[], { k: string }>(`SELECT k FROM t`).all();
    expect(all).toEqual([{ k: "a" }]);
  });

  it("binds a lone array as the anonymous parameter list", () => {
    for (const k of ["a", "b", "c"]) {
      db.prepare(`INSERT INTO t (k, v) VALUES (?, ?)`).run(k, 0);
    }
    // better-sqlite3 accepts `.all(arrayOfValues)` for `IN (?, ?, ?)`.
    const keys = ["a", "c"];
    const rows = db
      .prepare<[string[]], { k: string }>(
        `SELECT k FROM t WHERE k IN (${keys.map(() => "?").join(",")}) ORDER BY k`,
      )
      .all(keys);
    expect(rows).toEqual([{ k: "a" }, { k: "c" }]);
  });

  it("binds a plain object as named parameters (bare keys)", () => {
    db.prepare(`INSERT INTO t (k, v) VALUES (@k, @v)`).run({ k: "x", v: 9 });
    const row = db
      .prepare<[string], { v: number }>(`SELECT v FROM t WHERE k = ?`)
      .get("x");
    expect(row).toEqual({ v: 9 });
  });

  it("commits a transaction and rolls back on throw", () => {
    const insert = db.prepare(`INSERT INTO t (k, v) VALUES (?, ?)`);
    const count = () =>
      db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM t`).get()?.n;

    db.transaction(() => {
      insert.run("ok1", 1);
      insert.run("ok2", 2);
    })();
    expect(count()).toBe(2);

    expect(() =>
      db.transaction(() => {
        insert.run("ok3", 3);
        throw new Error("boom");
      })(),
    ).toThrow("boom");
    expect(count()).toBe(2); // rolled back
  });

  it("supports nested transactions via savepoints", () => {
    const insert = db.prepare(`INSERT INTO t (k, v) VALUES (?, ?)`);
    const inner = db.transaction((k: string) => {
      insert.run(k, 0);
    });
    db.transaction(() => {
      insert.run("outer", 0);
      inner("inner-committed");
      try {
        db.transaction(() => {
          insert.run("inner-rolled-back", 0);
          throw new Error("nope");
        })();
      } catch {
        /* swallowed: only the inner savepoint rolls back */
      }
    })();

    const keys = db
      .prepare<[], { k: string }>(`SELECT k FROM t ORDER BY k`)
      .all()
      .map((r) => r.k);
    expect(keys).toEqual(["inner-committed", "outer"]);
  });

  it("returns scalar pragma with { simple } and rows without", () => {
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    const cols = db.pragma("table_info(t)") as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(["id", "k", "v"]);
  });

  it("creates a usable backup copy", async () => {
    db.prepare(`INSERT INTO t (k, v) VALUES (?, ?)`).run("a", 1);
    const backupPath = join(dir, "backup.db");
    await db.backup(backupPath);

    const copy = new Database(backupPath, { readonly: true });
    try {
      const n = copy
        .prepare<[], { n: number }>(`SELECT count(*) AS n FROM t`)
        .get()?.n;
      expect(n).toBe(1);
    } finally {
      copy.close();
    }
  });

  it("throws when fileMustExist and the file is absent", () => {
    expect(
      () => new Database(join(dir, "missing.db"), { fileMustExist: true }),
    ).toThrow();
  });
});
