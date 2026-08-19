import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DERIVED_FIELD_HINTS,
  editDistance,
  isSelectLike,
} from "../src/commands/query.js";
import { openDb } from "../src/db/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(__dirname);
const TSX_BIN = join(REPO, "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(REPO, "src", "cli.ts");
const CLI_TEST_TIMEOUT = 15_000;

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-query-guardrails-"));
  return join(dir, "test.db");
}

async function runCli(args: string[], dbPath: string) {
  return execa(TSX_BIN, [CLI_ENTRY, ...args], {
    cwd: REPO,
    reject: false,
    env: { ...process.env, NO_COLOR: "1", AGENTMINE_DB: dbPath },
  });
}

describe("isSelectLike (unit)", () => {
  it("accepts SELECT / WITH / EXPLAIN with a single trailing terminator", () => {
    expect(isSelectLike("SELECT 1")).toBe(true);
    expect(isSelectLike("select 1;")).toBe(true);
    expect(isSelectLike("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
    expect(isSelectLike("EXPLAIN SELECT 1")).toBe(true);
  });

  it("keeps a semicolon inside a string literal usable as data", () => {
    // `prepare()` compiles only the first statement and the connection is
    // read-only, so nothing after a `;` runs. Guarding against chaining would
    // mean lexing SQL well enough to know this `;` is a search pattern.
    expect(
      isSelectLike("SELECT 1 FROM shell_commands WHERE cmd_full LIKE '%;%'"),
    ).toBe(true);
  });

  it("accepts allowlisted read-only introspection pragmas", () => {
    expect(isSelectLike("PRAGMA table_info(messages)")).toBe(true);
    expect(isSelectLike("pragma TABLE_INFO(messages);")).toBe(true);
    expect(isSelectLike("PRAGMA integrity_check")).toBe(true);
  });

  it("rejects pragma assignment forms and chained pragmas", () => {
    expect(isSelectLike("PRAGMA journal_mode=WAL")).toBe(false);
    expect(isSelectLike("PRAGMA user_version = 5")).toBe(false);
    expect(
      isSelectLike("PRAGMA table_info(messages); PRAGMA table_info(sessions)"),
    ).toBe(false);
  });

  it("rejects pragmas outside the introspection allowlist", () => {
    expect(isSelectLike("PRAGMA wal_checkpoint")).toBe(false);
    expect(isSelectLike("PRAGMA optimize")).toBe(false);
  });

  it("rejects writes and non-select statements", () => {
    expect(isSelectLike("DELETE FROM sessions")).toBe(false);
    expect(isSelectLike("INSERT INTO sessions (id) VALUES ('x')")).toBe(false);
    expect(isSelectLike("ATTACH DATABASE 'x.db' AS x")).toBe(false);
    expect(isSelectLike("UPDATE sessions SET title = 'x'")).toBe(false);
    expect(isSelectLike("DROP TABLE sessions")).toBe(false);
  });
});

describe("editDistance (unit)", () => {
  it("is 0 for identical strings and the length for an empty string", () => {
    expect(editDistance("text", "text")).toBe(0);
    expect(editDistance("", "text")).toBe(4);
    expect(editDistance("text", "")).toBe(4);
  });

  it("counts a single substitution as distance 1", () => {
    expect(editDistance("ts", "tz")).toBe(1);
  });
});

describe("DERIVED_FIELD_HINTS (unit)", () => {
  it("names the underlying stored column for each derived output field", () => {
    expect(DERIVED_FIELD_HINTS.started_at_iso).toContain("sessions.started_at");
    expect(DERIVED_FIELD_HINTS.ended_at_iso).toContain("sessions.ended_at");
    expect(DERIVED_FIELD_HINTS.first_user_prompt_preview).toContain(
      "sessions.first_user_prompt",
    );
    expect(DERIVED_FIELD_HINTS.reconstruct_command).toContain(
      "no underlying column",
    );
  });
});

describe("agentmine query guardrails (CLI)", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    const db = openDb({ path: dbPath });
    db.close();
  });

  afterEach(() => {
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  it(
    "accepts PRAGMA table_info(messages) and returns rows",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["query", "PRAGMA table_info(messages)"],
        dbPath,
      );
      expect(exitCode, stdout).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("success");
      const rows = parsed.data.rows as Array<{ name: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => r.name)).toContain("text");
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "rejects PRAGMA assignment forms",
    async () => {
      const journalMode = await runCli(
        ["query", "PRAGMA journal_mode=WAL"],
        dbPath,
      );
      expect(journalMode.exitCode).toBe(2);
      const journalParsed = JSON.parse(journalMode.stdout.trim());
      expect(journalParsed.status).toBe("error");
      expect(journalParsed.errors[0].name).toBe("INVALID_INPUT");

      const userVersion = await runCli(
        ["query", "PRAGMA user_version = 5"],
        dbPath,
      );
      expect(userVersion.exitCode).toBe(2);
      const userVersionParsed = JSON.parse(userVersion.stdout.trim());
      expect(userVersionParsed.status).toBe("error");
      expect(userVersionParsed.errors[0].name).toBe("INVALID_INPUT");
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "still rejects DELETE / INSERT / ATTACH",
    async () => {
      for (const sql of [
        "DELETE FROM sessions",
        "INSERT INTO sessions (id) VALUES ('x')",
        "ATTACH DATABASE 'x.db' AS x",
      ]) {
        const { exitCode, stdout } = await runCli(["query", sql], dbPath);
        expect(exitCode, `${sql} -> ${stdout}`).toBe(2);
        const parsed = JSON.parse(stdout.trim());
        expect(parsed.status).toBe("error");
        expect(parsed.errors[0].name).toBe("INVALID_INPUT");
        expect(parsed.errors[0].message).toContain("agentmine schema --tables");
      }
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "the non-SELECT refusal message points at agentmine schema --tables",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["query", "DROP TABLE sessions"],
        dbPath,
      );
      expect(exitCode).toBe(2);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.errors[0].message).toContain("agentmine schema --tables");
      expect(parsed.errors[0].message).toContain(
        "agentmine schema --table=<name>",
      );
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "a stale column name suggests the real one, scoped to its table",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["query", "SELECT content FROM messages"],
        dbPath,
      );
      expect(exitCode).toBe(2);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("error");
      expect(parsed.errors[0].name).toBe("INVALID_INPUT");
      expect(parsed.errors[0].message).toContain("messages.text");
      expect(parsed.errors[0].message).toContain("agentmine schema --table");
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "a derived output field name explains itself instead of guessing",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["query", "SELECT started_at_iso FROM sessions"],
        dbPath,
      );
      expect(exitCode).toBe(2);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("error");
      expect(parsed.errors[0].message).toContain("derived output field");
      expect(parsed.errors[0].message).toContain("started_at");
      expect(parsed.errors[0].message).toContain("agentmine sessions");
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "an unknown table name still points at agentmine schema --tables",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["query", "SELECT * FROM sessionz"],
        dbPath,
      );
      expect(exitCode).toBe(2);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.errors[0].message).toContain("agentmine schema --tables");
    },
    CLI_TEST_TIMEOUT,
  );
});
