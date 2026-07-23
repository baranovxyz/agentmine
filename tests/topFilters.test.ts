import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalSession } from "../src/adapters/types.js";
import { parseSince, parseUntil } from "../src/commands/_filters.js";
import { openDb } from "../src/db/client.js";
import { upsertSession } from "../src/db/writer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);
const TSX_BIN = join(REPO, "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(REPO, "src", "cli.ts");
const CLI_TEST_TIMEOUT = 15_000;

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-filters-test-"));
  return join(dir, "test.db");
}

function makeSession(
  overrides: Partial<CanonicalSession> = {},
): CanonicalSession {
  return {
    id: `cc--${randomUUID()}`,
    source: "claude-code",
    projectPath: "/tmp/proj",
    messages: [],
    contentHash: randomUUID(),
    ...overrides,
  };
}

async function runCli(args: string[], dbPath: string) {
  return execa(TSX_BIN, [CLI_ENTRY, ...args], {
    cwd: REPO,
    reject: false,
    env: { ...process.env, NO_COLOR: "1", AGENTMINE_DB: dbPath },
  });
}

describe("_filters parser unit tests", () => {
  it("parseSince accepts ISO date", () => {
    expect(parseSince("2026-05-08T00:00:00Z")).toBe(
      Math.floor(Date.parse("2026-05-08T00:00:00Z") / 1000),
    );
  });

  it("parseSince accepts bare YYYY-MM-DD as UTC midnight", () => {
    expect(parseSince("2026-05-08")).toBe(
      Math.floor(Date.parse("2026-05-08T00:00:00Z") / 1000),
    );
  });

  it("parseSince accepts relative offsets (d, w, h, m, s)", () => {
    const now = Math.floor(Date.now() / 1000);
    const sevenDays = parseSince("7d")!;
    expect(Math.abs(now - 7 * 86400 - sevenDays)).toBeLessThan(2);

    const twoWeeks = parseSince("2w")!;
    expect(Math.abs(now - 14 * 86400 - twoWeeks)).toBeLessThan(2);

    const twelveHours = parseSince("12h")!;
    expect(Math.abs(now - 12 * 3600 - twelveHours)).toBeLessThan(2);

    const thirtyMin = parseSince("30m")!;
    expect(Math.abs(now - 30 * 60 - thirtyMin)).toBeLessThan(2);
  });

  it("parseSince returns null for unparseable input", () => {
    expect(parseSince("not-a-date")).toBeNull();
    expect(parseSince("7q")).toBeNull();
    expect(parseSince("")).toBeNull();
  });

  it("rejects impossible calendar dates instead of normalizing them", () => {
    expect(parseSince("2026-02-29")).toBeNull();
    expect(parseSince("2026-02-30T12:00:00Z")).toBeNull();
    expect(parseUntil("2026-04-31")).toBeNull();
    expect(parseSince("2024-02-29")).toBe(
      Math.floor(Date.parse("2024-02-29T00:00:00Z") / 1000),
    );
  });

  it("parseUntil resolves bare YYYY-MM-DD to start of next UTC day (exclusive)", () => {
    const may8End = parseUntil("2026-05-08")!;
    expect(may8End).toBe(Math.floor(Date.parse("2026-05-09T00:00:00Z") / 1000));
  });

  it("parseUntil accepts ISO timestamp as-is", () => {
    expect(parseUntil("2026-05-08T12:30:00Z")).toBe(
      Math.floor(Date.parse("2026-05-08T12:30:00Z") / 1000),
    );
  });
});

describe("agentmine top skills --since/--until", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    const db = openDb({ path: dbPath });

    // Old session (Apr 1) and recent session (today). Both have one skill.
    const apr1 = Math.floor(Date.parse("2026-04-01T12:00:00Z") / 1000);
    const today = Math.floor(Date.now() / 1000);

    upsertSession(db, makeSession({ id: "old-session", startedAt: apr1 }));
    upsertSession(db, makeSession({ id: "new-session", startedAt: today }));

    db.prepare(
      `INSERT INTO skills_invoked (session_id, turn, idx, skill_name) VALUES (?, ?, ?, ?)`,
    ).run("old-session", 1, 0, "old-skill");
    db.prepare(
      `INSERT INTO skills_invoked (session_id, turn, idx, skill_name) VALUES (?, ?, ?, ?)`,
    ).run("new-session", 1, 0, "new-skill");
    db.close();
  });

  afterEach(() => {
    rmSync(dbPath, { force: true, recursive: true });
  });

  it(
    "with no filter, returns both skills",
    async () => {
      const { exitCode, stdout } = await runCli(["top", "skills"], dbPath);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("success");
      const names = (parsed.data.rows as Array<{ skill_name: string }>)
        .map((r) => r.skill_name)
        .sort();
      expect(names).toEqual(["new-skill", "old-skill"]);
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "with --since 7d, returns only the recent skill",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["top", "skills", "--since", "7d"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      const names = (parsed.data.rows as Array<{ skill_name: string }>).map(
        (r) => r.skill_name,
      );
      expect(names).toEqual(["new-skill"]);
      expect(parsed.data.since_epoch).toBeGreaterThan(0);
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "with --until 2026-04-30, returns only the old skill",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["top", "skills", "--until", "2026-04-30"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      const names = (parsed.data.rows as Array<{ skill_name: string }>).map(
        (r) => r.skill_name,
      );
      expect(names).toEqual(["old-skill"]);
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "with malformed --since, returns INVALID_INPUT error",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["top", "skills", "--since", "not-a-date"],
        dbPath,
      );
      expect(exitCode).not.toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("error");
      expect(parsed.errors[0].name).toBe("INVALID_INPUT");
      expect(parsed.errors[0].message).toContain("--since");
    },
    CLI_TEST_TIMEOUT,
  );
});

describe("agentmine top subagents --since/--until", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    const db = openDb({ path: dbPath });

    const apr1 = Math.floor(Date.parse("2026-04-01T12:00:00Z") / 1000);
    const today = Math.floor(Date.now() / 1000);

    upsertSession(db, makeSession({ id: "old-parent", startedAt: apr1 }));
    upsertSession(db, makeSession({ id: "new-parent", startedAt: today }));

    db.prepare(
      `INSERT INTO subagent_invocations
         (parent_session_id, parent_turn, idx, child_session_id, subagent_type, task_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("old-parent", 1, 0, null, "old-agent", "old work");
    db.prepare(
      `INSERT INTO subagent_invocations
         (parent_session_id, parent_turn, idx, child_session_id, subagent_type, task_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("new-parent", 1, 0, null, "new-agent", "new work");
    db.close();
  });

  afterEach(() => {
    rmSync(dbPath, { force: true, recursive: true });
  });

  it(
    "with --since 7d, returns only the recent subagent",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["top", "subagents", "--since", "7d"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      const types = (parsed.data.rows as Array<{ subagent_type: string }>).map(
        (r) => r.subagent_type,
      );
      expect(types).toEqual(["new-agent"]);
    },
    CLI_TEST_TIMEOUT,
  );
});

describe("agentmine top sequences --project", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    const db = openDb({ path: dbPath });

    // Two sessions in /home/me/repo with a repeating Edit→Bash→Edit sequence
    // (3 occurrences each); one session in /home/me/other with a different
    // sequence that must not leak into repo-scoped results.
    upsertSession(
      db,
      makeSession({ id: "repo-a", projectPath: "/home/me/repo" }),
    );
    upsertSession(
      db,
      makeSession({ id: "repo-b", projectPath: "/home/me/repo/.worktrees/x" }),
    );
    upsertSession(
      db,
      makeSession({ id: "other", projectPath: "/home/me/other" }),
    );

    const insert = db.prepare(
      `INSERT INTO tool_calls (session_id, turn, idx, name) VALUES (?, ?, ?, ?)`,
    );
    // repo-a: Edit Bash Edit Bash Edit Bash Edit Bash Edit — 3 occurrences of Edit→Bash→Edit
    const lcSeq = [
      "Edit",
      "Bash",
      "Edit",
      "Bash",
      "Edit",
      "Bash",
      "Edit",
      "Bash",
      "Edit",
    ];
    lcSeq.forEach((name, i) => {
      insert.run("repo-a", Math.floor(i / 3) + 1, i, name);
    });
    // repo-b: same shape, separate session — bumps `sessions` count
    lcSeq.forEach((name, i) => {
      insert.run("repo-b", Math.floor(i / 3) + 1, i, name);
    });
    // other: only Read→Read→Read patterns, should NOT appear in repo scope
    ["Read", "Read", "Read", "Read", "Read"].forEach((name, i) => {
      insert.run("other", 1, i, name);
    });
    db.close();
  });

  afterEach(() => {
    rmSync(dbPath, { force: true, recursive: true });
  });

  it(
    "re-aggregates ngrams scoped to the project_path LIKE pattern",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["top", "sequences", "--project", "/home/me/repo%", "--n", "3"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("success");
      expect(parsed.data.project).toBe("/home/me/repo%");
      expect(parsed.data.sessions_scanned).toBe(2);

      const rows = parsed.data.rows as Array<{
        sequence: string;
        count: number;
        sessions: number;
      }>;
      const ebe = rows.find((r) => r.sequence === "Edit → Bash → Edit");
      expect(ebe).toBeTruthy();
      expect(ebe?.sessions).toBe(2);
      // No Read sequences should leak from the `other` project
      expect(rows.find((r) => r.sequence.startsWith("Read"))).toBeUndefined();
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "uses pre-aggregated ngram table when --project is omitted",
    async () => {
      // No extract has been run, so tool_call_ngrams is empty.
      // The command should query it directly and return zero rows.
      const { exitCode, stdout } = await runCli(["top", "sequences"], dbPath);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("success");
      expect(parsed.data.rows).toEqual([]);
      expect(parsed.data.project).toBeUndefined();
    },
    CLI_TEST_TIMEOUT,
  );
});

describe("agentmine top tokens", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    const db = openDb({ path: dbPath });

    const apr1 = Math.floor(Date.parse("2026-04-01T12:00:00Z") / 1000);
    const may15 = Math.floor(Date.parse("2026-05-15T12:00:00Z") / 1000);

    upsertSession(
      db,
      makeSession({
        id: "s-opus",
        model: "claude-opus-4-7",
        projectPath: "/home/me/repo",
        startedAt: may15,
        inputTokens: 100,
        outputTokens: 5000,
        cacheReadTokens: 200000,
        cacheCreationTokens: 1000,
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "s-haiku",
        model: "claude-haiku-4-5",
        projectPath: "/home/me/repo",
        startedAt: may15,
        inputTokens: 10,
        outputTokens: 100,
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "s-gpt",
        model: "gpt-5.5",
        projectPath: "/home/me/other",
        startedAt: apr1,
        inputTokens: 50000,
        outputTokens: 500,
      }),
    );
    db.close();
  });

  afterEach(() => {
    rmSync(dbPath, { force: true, recursive: true });
  });

  it(
    "groups by model and ranks by total token volume",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["top", "tokens", "--by", "model"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("success");
      const rows = parsed.data.rows as Array<{
        model: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        sessions: number;
      }>;
      expect(rows[0]?.model).toBe("claude-opus-4-7"); // cache_read=200k dominates
      expect(rows[0]?.cache_read_tokens).toBe(200000);
      const gpt = rows.find((r) => r.model === "gpt-5.5");
      expect(gpt?.input_tokens).toBe(50000);
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "filters by --project LIKE pattern",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["top", "tokens", "--by", "project", "--project", "/home/me/repo%"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      const projects = (
        parsed.data.rows as Array<{ project_path: string }>
      ).map((r) => r.project_path);
      expect(projects).toEqual(["/home/me/repo"]);
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "by=session emits per-session rows usable as ccusage input",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["top", "tokens", "--by", "session", "--limit", "3"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      const rows = parsed.data.rows as Array<{
        session_id: string;
        cache_read_tokens: number;
      }>;
      expect(rows[0]?.session_id).toBe("s-opus");
      expect(rows.map((r) => r.session_id)).toEqual([
        "s-opus",
        "s-gpt",
        "s-haiku",
      ]);
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "rejects unknown --by value",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["top", "tokens", "--by", "bogus"],
        dbPath,
      );
      expect(exitCode).not.toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("error");
      expect(parsed.errors[0].name).toBe("INVALID_INPUT");
    },
    CLI_TEST_TIMEOUT,
  );
});
