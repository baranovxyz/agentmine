import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalSession } from "../src/adapters/types.js";
import { parseSince, parseUntil } from "../src/commands/_filters.js";
import {
  CODEX_TOKEN_USAGE_BACKFILL_META_KEY,
  CURRENT_SCHEMA_VERSION,
  getMeta,
  openDb,
  upsertMeta,
} from "../src/db/client.js";
import { upsertSessionWithPayload } from "../src/db/writer.js";

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

    upsertSessionWithPayload(
      db,
      makeSession({ id: "old-session", startedAt: apr1 }),
    );
    upsertSessionWithPayload(
      db,
      makeSession({ id: "new-session", startedAt: today }),
    );

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

    upsertSessionWithPayload(
      db,
      makeSession({ id: "old-parent", startedAt: apr1 }),
    );
    upsertSessionWithPayload(
      db,
      makeSession({ id: "new-parent", startedAt: today }),
    );

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
    upsertSessionWithPayload(
      db,
      makeSession({ id: "repo-a", projectPath: "/home/me/repo" }),
    );
    upsertSessionWithPayload(
      db,
      makeSession({ id: "repo-b", projectPath: "/home/me/repo/.worktrees/x" }),
    );
    upsertSessionWithPayload(
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

    upsertSessionWithPayload(
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
    upsertSessionWithPayload(
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
    upsertSessionWithPayload(
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
    "prices cached Codex input once while preserving disjoint source counters",
    async () => {
      const db = openDb({ path: dbPath });
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "s-codex-cache",
          source: "codex",
          model: "priced-test",
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 700_000,
          cacheCreationTokens: 100_000,
        }),
      );
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "s-cline-cache",
          source: "cline",
          model: "priced-test",
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 700_000,
          cacheCreationTokens: 100_000,
        }),
      );
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "s-qwen-cache",
          source: "qwen",
          model: "priced-test",
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 700_000,
        }),
      );
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "s-disjoint-cache",
          source: "claude-code",
          model: "priced-test",
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 700_000,
          cacheCreationTokens: 100_000,
        }),
      );
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "s-gemini-cache",
          source: "gemini",
          model: "priced-test",
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 700_000,
          cacheCreationTokens: 100_000,
        }),
      );
      db.prepare(
        `INSERT INTO model_prices
           (model, input_per_mtok, output_per_mtok, cache_read_per_mtok,
            cache_write_per_mtok, source)
         VALUES ('priced-test', 10, 20, 1, 12.5, 'snapshot')`,
      ).run();
      db.close();

      const { exitCode, stdout } = await runCli(
        ["top", "tokens", "--by", "session", "--limit", "10"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      const rows = parsed.data.rows as Array<{
        session_id: string;
        billable_input_tokens: number;
        cost_usd: number;
      }>;
      const codex = rows.find((row) => row.session_id === "s-codex-cache");
      const cline = rows.find((row) => row.session_id === "s-cline-cache");
      const disjoint = rows.find(
        (row) => row.session_id === "s-disjoint-cache",
      );
      const qwen = rows.find((row) => row.session_id === "s-qwen-cache");
      const gemini = rows.find((row) => row.session_id === "s-gemini-cache");
      expect(codex?.billable_input_tokens).toBe(200_000);
      expect(codex?.cost_usd).toBe(5.95);
      expect(cline?.billable_input_tokens).toBe(200_000);
      expect(cline?.cost_usd).toBe(5.95);
      expect(qwen?.billable_input_tokens).toBe(300_000);
      expect(qwen?.cost_usd).toBe(5.7);
      expect(gemini?.billable_input_tokens).toBe(1_000_000);
      expect(gemini?.cost_usd).toBe(13.95);
      expect(disjoint?.billable_input_tokens).toBe(1_000_000);
      expect(disjoint?.cost_usd).toBe(13.95);
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "prices source-aware reasoning once and discloses unknown overlap semantics",
    async () => {
      const db = openDb({ path: dbPath });
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "s-codex-reasoning-only",
          source: "codex",
          model: "reasoning-model",
          reasoningTokens: 100_000,
        }),
      );
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "s-gemini-reasoning",
          source: "gemini",
          model: "reasoning-model",
          outputTokens: 100_000,
          reasoningTokens: 50_000,
        }),
      );
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "s-custom-ambiguous",
          source: "custom-agent",
          model: "reasoning-model",
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 800_000,
          reasoningTokens: 50_000,
        }),
      );
      db.prepare(
        `INSERT INTO model_prices
           (model, input_per_mtok, output_per_mtok, cache_read_per_mtok,
            cache_write_per_mtok, source)
         VALUES ('reasoning-model', 10, 20, 2, 12.5, 'snapshot')`,
      ).run();
      db.close();

      const { exitCode, stdout } = await runCli(
        ["top", "tokens", "--by", "session", "--limit", "10"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      const rows = parsed.data.rows as Array<{
        session_id: string;
        billable_input_tokens: number;
        billable_output_tokens: number;
        cost_usd: number;
        unpriced: number;
      }>;
      expect(
        rows.find((row) => row.session_id === "s-codex-reasoning-only"),
      ).toMatchObject({
        billable_output_tokens: 100_000,
        cost_usd: 2,
        unpriced: 0,
      });
      expect(
        rows.find((row) => row.session_id === "s-gemini-reasoning"),
      ).toMatchObject({
        billable_output_tokens: 150_000,
        cost_usd: 3,
        unpriced: 0,
      });
      expect(
        rows.find((row) => row.session_id === "s-custom-ambiguous"),
      ).toMatchObject({
        billable_input_tokens: 0,
        billable_output_tokens: 100_000,
        cost_usd: 3.6,
        unpriced: 1,
      });
      expect(parsed.warnings).toContainEqual(
        expect.objectContaining({ name: "INCOMPLETE_PRICING" }),
      );
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "includes cache-only partial sessions and prices their available category",
    async () => {
      const db = openDb({ path: dbPath });
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "s-cache-only",
          source: "codex",
          model: "cache-only-model",
          cacheReadTokens: 100_000,
        }),
      );
      db.prepare(
        `INSERT INTO model_prices
           (model, input_per_mtok, output_per_mtok, cache_read_per_mtok,
            cache_write_per_mtok, source)
         VALUES ('cache-only-model', 10, 20, 2, 12.5, 'snapshot')`,
      ).run();
      db.close();

      const { exitCode, stdout } = await runCli(
        ["top", "tokens", "--by", "session", "--limit", "10"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      const row = (
        parsed.data.rows as Array<{
          session_id: string;
          billable_input_tokens: number;
          cache_read_tokens: number;
          cost_usd: number;
        }>
      ).find((candidate) => candidate.session_id === "s-cache-only");
      expect(row).toMatchObject({
        billable_input_tokens: 0,
        cache_read_tokens: 100_000,
        cost_usd: 0.2,
      });
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "refuses token costs while the schema-v15 Codex backfill is pending",
    async () => {
      const db = openDb({ path: dbPath });
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "s-stale-codex",
          source: "codex",
          model: "gpt-5.6-sol",
          inputTokens: 1_100_000,
          outputTokens: 100_000,
          cacheReadTokens: 900_000,
        }),
      );
      upsertMeta(db, "schema_version", "14");
      db.close();

      const sync = await runCli(["prices", "sync"], dbPath);
      expect(sync.exitCode).toBe(0);

      const migrated = openDb({ readonly: true, init: false, path: dbPath });
      const stale = migrated
        .prepare<
          [],
          { input_tokens: number | null; output_tokens: number | null }
        >(
          `SELECT input_tokens, output_tokens
             FROM sessions WHERE id = 's-stale-codex'`,
        )
        .get();
      expect(stale).toEqual({ input_tokens: null, output_tokens: null });
      expect(getMeta(migrated, CODEX_TOKEN_USAGE_BACKFILL_META_KEY)).toBe("1");
      migrated.close();

      const top = await runCli(["top", "tokens", "--by", "session"], dbPath);
      expect(top.exitCode).toBe(3);
      const parsed = JSON.parse(top.stdout.trim());
      expect(parsed.status).toBe("error");
      expect(parsed.errors).toContainEqual(
        expect.objectContaining({
          name: "DB_ERROR",
          message: expect.stringContaining(
            "codex_token_usage_backfill_remaining is 0",
          ),
        }),
      );
    },
    CLI_TEST_TIMEOUT,
  );

  it("refuses malformed persisted token counters instead of returning negative cost", async () => {
    const db = openDb({ path: dbPath });
    upsertSessionWithPayload(
      db,
      makeSession({
        id: "s-negative-usage",
        source: "codex",
        model: "gpt-5.4",
        inputTokens: -1_000_000,
        outputTokens: -150_000,
        cacheReadTokens: -800_000,
      }),
    );
    db.close();

    const { exitCode, stdout } = await runCli(
      ["top", "tokens", "--by", "session"],
      dbPath,
    );
    expect(exitCode).toBe(3);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      status: "error",
      errors: [
        {
          name: "DB_ERROR",
          message: expect.stringContaining("malformed token counters"),
        },
      ],
    });
    expect(stdout).not.toContain('"cost_usd":-');
  });

  it("scopes malformed-counter validation to rows included in the grouping", async () => {
    const db = openDb({ path: dbPath });
    upsertSessionWithPayload(
      db,
      makeSession({
        id: "s-negative-without-model",
        source: "codex",
        model: undefined,
        inputTokens: -1,
      }),
    );
    db.close();

    const { exitCode, stdout } = await runCli(
      ["top", "tokens", "--by", "model"],
      dbPath,
    );
    expect(exitCode).toBe(0);
    const rows = JSON.parse(stdout.trim()).data.rows as Array<{
      model: string;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows).not.toContainEqual(expect.objectContaining({ model: null }));
  });

  it("refuses stale Codex costs when schema metadata is only partially numeric", async () => {
    const db = openDb({ path: dbPath });
    upsertSessionWithPayload(
      db,
      makeSession({
        id: "s-invalid-schema-version",
        source: "codex",
        model: "gpt-5.4",
        inputTokens: 100,
      }),
    );
    upsertMeta(db, "schema_version", "15junk");
    db.close();

    const { exitCode, stdout } = await runCli(
      ["top", "tokens", "--by", "session"],
      dbPath,
    );
    expect(exitCode).toBe(3);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      status: "error",
      errors: [
        {
          name: "DB_ERROR",
          message: expect.stringContaining("backfill is pending"),
        },
      ],
    });
  });

  it("refuses a future corpus schema without changing it", async () => {
    // One past what this build supports, so the case stays "future" across
    // every schema bump rather than becoming the current version.
    const futureVersion = String(CURRENT_SCHEMA_VERSION + 1);
    const db = openDb({ path: dbPath });
    upsertMeta(db, "schema_version", futureVersion);
    db.close();

    const { exitCode, stdout } = await runCli(
      ["top", "tokens", "--by", "session"],
      dbPath,
    );
    expect(exitCode).toBe(3);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      status: "error",
      errors: [
        {
          name: "DB_ERROR",
          message: expect.stringContaining(
            `schema version ${futureVersion} is newer`,
          ),
        },
      ],
    });
  });

  it(
    "marks NULL price rows as incomplete instead of reporting a complete zero cost",
    async () => {
      const db = openDb({ path: dbPath });
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "s-unpriced",
          model: "unknown-priced-model",
          inputTokens: 1_000,
          outputTokens: 100,
        }),
      );
      db.prepare(
        `INSERT INTO model_prices
           (model, input_per_mtok, output_per_mtok, cache_read_per_mtok,
            cache_write_per_mtok, source)
         VALUES ('unknown-priced-model', NULL, NULL, NULL, NULL, 'snapshot')`,
      ).run();
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "s-priced-top",
          model: "priced-top-model",
          inputTokens: 2_000_000,
          outputTokens: 100,
        }),
      );
      db.prepare(
        `INSERT INTO model_prices
           (model, input_per_mtok, output_per_mtok, cache_read_per_mtok,
            cache_write_per_mtok, source)
         VALUES ('priced-top-model', 1, 1, 1, 1, 'snapshot')`,
      ).run();
      db.close();

      const { exitCode, stdout } = await runCli(
        ["top", "tokens", "--by", "model", "--limit", "10"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      const row = (
        parsed.data.rows as Array<{
          model: string;
          cost_usd: number;
          unpriced_sessions: number;
        }>
      ).find((candidate) => candidate.model === "unknown-priced-model");
      expect(row?.cost_usd).toBe(0);
      expect(row?.unpriced_sessions).toBe(1);
      expect(parsed.warnings).toContainEqual(
        expect.objectContaining({ name: "INCOMPLETE_PRICING" }),
      );

      const limited = await runCli(
        ["top", "tokens", "--by", "model", "--limit", "1"],
        dbPath,
      );
      const limitedParsed = JSON.parse(limited.stdout.trim());
      expect(limitedParsed.data.rows).toHaveLength(1);
      expect(limitedParsed.data.rows[0].model).toBe("priced-top-model");
      expect(limitedParsed.warnings).toContainEqual(
        expect.objectContaining({
          name: "INCOMPLETE_PRICING",
          message: expect.stringContaining("4 session"),
        }),
      );
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "marks a session incomplete when one used token category lacks a price",
    async () => {
      const db = openDb({ path: dbPath });
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "s-missing-cache-write-price",
          model: "partial-price-model",
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheCreationTokens: 200_000,
        }),
      );
      db.prepare(
        `INSERT INTO model_prices
           (model, input_per_mtok, output_per_mtok, cache_read_per_mtok,
            cache_write_per_mtok, source)
         VALUES ('partial-price-model', 2, 10, 1, NULL, 'snapshot')`,
      ).run();
      db.close();

      const { exitCode, stdout } = await runCli(
        ["top", "tokens", "--by", "session", "--limit", "10"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      const row = (
        parsed.data.rows as Array<{
          session_id: string;
          cost_usd: number;
          unpriced: number;
        }>
      ).find(
        (candidate) => candidate.session_id === "s-missing-cache-write-price",
      );
      expect(row).toMatchObject({ cost_usd: 3, unpriced: 1 });
      expect(parsed.warnings).toContainEqual(
        expect.objectContaining({
          name: "INCOMPLETE_PRICING",
          message: expect.stringContaining("lower bound"),
        }),
      );
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
