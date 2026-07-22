import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CanonicalSession, Message } from "../src/adapters/types.js";
import { openDb } from "../src/db/client.js";
import {
  clearDirtySessions,
  getDirtySessions,
  upsertSession,
} from "../src/db/writer.js";
import { runAllExtractors } from "../src/extract/index.js";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-inc-"));
  return join(dir, "test.db");
}

/** Fact + rollup tables owned by `extract`, compared as order-independent sets. */
const FACT_TABLES = [
  "files_touched",
  "shell_commands",
  "tool_errors",
  "user_corrections",
  "skills_invoked",
  "skills_available",
  "skills_hook_injected",
  "mcp_calls",
  "web_fetches",
  "git_operations",
  "todo_events",
  "user_interruptions",
  "tool_call_ngrams",
  "prompt_templates",
  "friction_events",
  "subagent_invocations",
  "self_resolutions",
  "search_calls",
];

/**
 * Snapshot every extract-owned table as a sorted list of JSON rows (excluding
 * any autoincrement `id`, whose value depends on insertion order). Two runs
 * that produce the same facts compare equal regardless of row order.
 */
function snapshotFacts(
  db: ReturnType<typeof openDb>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const table of FACT_TABLES) {
    const rows = db
      .prepare<[], Record<string, unknown>>(`SELECT * FROM ${table}`)
      .all()
      .map((r) => {
        const { id: _id, ...rest } = r as { id?: unknown };
        return JSON.stringify(rest);
      })
      .sort();
    out[table] = rows;
  }
  // Session-level rollups that extract writes back.
  out.__sessions = db
    .prepare<[], Record<string, unknown>>(
      `SELECT id, ended_with_commit, ended_with_commit_attempted, subagent_count, has_subagents FROM sessions`,
    )
    .all()
    .map((r) => JSON.stringify(r))
    .sort();
  return out;
}

function msg(overrides: Partial<Message>): Message {
  return { turn: 0, role: "user", text: "", toolCalls: [], ...overrides };
}

/** A content-rich session that exercises most fact extractors. */
function richSession(id: string, variant: number): CanonicalSession {
  const messages: Message[] = [
    msg({ turn: 1, role: "user", text: `do the work ${variant}` }),
    msg({
      turn: 2,
      role: "assistant",
      text: "on it",
      toolCalls: [
        {
          name: "Bash",
          argsHash: "h1",
          argsPreview: "git commit",
          args: { command: `git commit -m "v${variant}"` },
          exitCode: 0,
        },
        {
          name: "Read",
          argsHash: "h2",
          argsPreview: "read",
          args: { file_path: `/repo/file${variant}.ts` },
        },
        {
          name: "Grep",
          argsHash: "h3",
          argsPreview: "grep",
          args: { pattern: `TODO${variant}` },
        },
        {
          name: "mytool",
          argsHash: "h4",
          argsPreview: "fail",
          args: { x: variant },
          exitCode: 2,
        },
      ],
    }),
    msg({
      turn: 3,
      role: "assistant",
      text: "retry",
      toolCalls: [
        {
          name: "mytool",
          argsHash: "h4",
          argsPreview: "ok",
          args: { x: variant },
          exitCode: 0,
        },
      ],
    }),
    msg({ turn: 4, role: "user", text: "no, that's wrong" }),
  ];
  return {
    id,
    source: "claude-code",
    projectPath: `/repo${variant}`,
    messages,
    contentHash: `${id}-v${variant}`,
  };
}

describe("incremental extract == full rebuild", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  it("marks upserted sessions dirty", () => {
    const db = openDb({ path: dbPath });
    upsertSession(db, richSession("cc--a", 1));
    upsertSession(db, richSession("cc--b", 1));
    expect(getDirtySessions(db).sort()).toEqual(["cc--a", "cc--b"]);
    clearDirtySessions(db, ["cc--a"]);
    expect(getDirtySessions(db)).toEqual(["cc--b"]);
    db.close();
  });

  it("scoped rebuild of a changed session matches a full rebuild", () => {
    const db = openDb({ path: dbPath });
    // Three sessions, initial full extract.
    upsertSession(db, richSession("cc--a", 1));
    upsertSession(db, richSession("cc--b", 1));
    upsertSession(db, richSession("cc--c", 1));
    runAllExtractors(db, null);

    // Change one session's content, then extract ONLY that session.
    upsertSession(db, richSession("cc--b", 2));
    runAllExtractors(db, ["cc--b"]);
    const incremental = snapshotFacts(db);

    // A full rebuild over the same final DB state is the reference.
    runAllExtractors(db, null);
    const full = snapshotFacts(db);

    expect(incremental).toEqual(full);
    db.close();
  });

  it("scoped rebuild of a brand-new session matches a full rebuild", () => {
    const db = openDb({ path: dbPath });
    upsertSession(db, richSession("cc--a", 1));
    upsertSession(db, richSession("cc--b", 1));
    runAllExtractors(db, null);

    // A new session arrives; extract only it.
    upsertSession(db, richSession("cc--c", 3));
    runAllExtractors(db, ["cc--c"]);
    const incremental = snapshotFacts(db);

    runAllExtractors(db, null);
    const full = snapshotFacts(db);

    expect(incremental).toEqual(full);
    db.close();
  });
});
