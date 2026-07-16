import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CanonicalSession } from "../src/adapters/types.js";
import { openDb } from "../src/db/client.js";
import { upsertSession } from "../src/db/writer.js";
import { classify } from "../src/extract/corrections.js";
import { runAllExtractors } from "../src/extract/index.js";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-test-"));
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

describe("corrections classifier", () => {
  it("returns reject for 'no, actually that's wrong'", () => {
    expect(classify("no, that's wrong")?.kind).toBe("reject");
    expect(classify("stop")?.kind).toBe("reject");
    expect(classify("nope")?.kind).toBe("reject");
  });

  it("returns undo for revert/rollback language", () => {
    expect(classify("please revert that change")?.kind).toBe("undo");
    expect(classify("roll back the last commit")?.kind).toBe("undo");
  });

  it("returns factual when opener + specific anchor", () => {
    expect(classify("actually the port is 8080")?.kind).toBe("factual");
    expect(classify("not quite, it is 'foo' not 'bar'")?.kind).toBe("factual");
  });

  it("returns style for rewrite/language requests", () => {
    expect(classify("rewrite that shorter")?.kind).toBe("style");
    expect(classify("make it simpler")?.kind).toBe("style");
    expect(classify("по-русски, пожалуйста")?.kind).toBe("style");
  });

  it("returns pivot for 'instead'/'start over'", () => {
    expect(classify("instead, use a different approach")?.kind).toBe("pivot");
    expect(classify("scratch that")?.kind).toBe("pivot");
  });

  it("returns null for uncorrected follow-ups", () => {
    expect(classify("great, now run the tests")).toBeNull();
    expect(classify("ok thanks")).toBeNull();
  });
});

describe("user_corrections injected-content filter", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  it("skips runtime-injected user turns while retaining authored corrections", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cc--noise-1",
        contentHash: "noise-1",
        messages: [
          { turn: 1, role: "user", text: "kick off", toolCalls: [] },
          { turn: 2, role: "assistant", text: "working", toolCalls: [] },
          // Injected skill content would otherwise classify as `style` because
          // it contains "simpler" and "rewrite".
          {
            turn: 3,
            role: "user",
            text: "Base directory for this skill: /home/u/.claude/skills/foo\n\n# Foo\n\nrewrite it shorter and simpler",
            toolCalls: [],
          },
          // Runtime-provided context continuation.
          {
            turn: 4,
            role: "user",
            text: "This session is being continued from a previous session that ran out of context. Please revert to the prior approach.",
            toolCalls: [],
          },
          // Authored correction should still be captured.
          { turn: 5, role: "user", text: "no, that's wrong", toolCalls: [] },
        ],
      }),
    );
    const { user_corrections } = runAllExtractors(db);
    expect(user_corrections).toBe(1);
    const row = db.prepare(`SELECT turn, kind FROM user_corrections`).get() as {
      turn: number;
      kind: string;
    };
    expect(row.turn).toBe(5);
    expect(row.kind).toBe("reject");
    db.close();
    rmSync(dbPath, { force: true });
  });
});

describe("files / shell / errors extractors", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  it("extracts files_touched from Read/Edit/Write tool calls", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        messages: [
          {
            turn: 1,
            role: "user",
            text: "do it",
            toolCalls: [],
          },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Read",
                args: { file_path: "/a/b.ts" },
                argsHash: "h1",
                argsPreview: "",
              },
              {
                name: "Edit",
                args: {
                  file_path: "/a/b.ts",
                  old_string: "x",
                  new_string: "y",
                },
                argsHash: "h2",
                argsPreview: "",
              },
              {
                name: "Write",
                args: { file_path: "/a/c.ts", content: "..." },
                argsHash: "h3",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    const { files_touched } = runAllExtractors(db);
    expect(files_touched).toBe(3);
    const rows = db
      .prepare(`SELECT op, path FROM files_touched ORDER BY op, path`)
      .all() as Array<{ op: string; path: string }>;
    expect(rows).toEqual([
      { op: "edit", path: "/a/b.ts" },
      { op: "read", path: "/a/b.ts" },
      { op: "write", path: "/a/c.ts" },
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("extracts files_touched from lower snake-case file tool calls", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        messages: [
          { turn: 1, role: "user", text: "do it", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "read_file",
                args: { path: "src/input.ts" },
                argsHash: "h1",
                argsPreview: "",
              },
              {
                name: "write_to_file",
                args: { rel_path: "src/output.ts", content: "..." },
                argsHash: "h2",
                argsPreview: "",
              },
              {
                name: "replace_in_file",
                args: { target_file: "src/output.ts" },
                argsHash: "h3",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    const { files_touched } = runAllExtractors(db);
    expect(files_touched).toBe(3);
    const rows = db
      .prepare(`SELECT op, path FROM files_touched ORDER BY op, path`)
      .all() as Array<{ op: string; path: string }>;
    expect(rows).toEqual([
      { op: "edit", path: "src/output.ts" },
      { op: "read", path: "src/input.ts" },
      { op: "write", path: "src/output.ts" },
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("persists raw events and full tool outputs for normalized sessions", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        rawEvents: [
          {
            seq: 0,
            eventType: "user",
            ts: 1700000000,
            rawJson: '{"type":"user"}',
          },
          { seq: 1, eventType: "assistant", rawJson: '{"type":"assistant"}' },
        ],
        messages: [
          { turn: 1, role: "user", text: "do it", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Bash",
                args: { command: "printf long" },
                argsHash: "h1",
                argsPreview: "",
                outputPreview: "short",
                outputFull: "short plus the full untruncated output",
                outputBytes: 36,
                outputSha: "sha",
                exitCode: 0,
              },
            ],
          },
        ],
      }),
    );
    const raw = db
      .prepare(`SELECT event_type, raw_json FROM raw_events ORDER BY seq`)
      .all() as Array<{ event_type: string; raw_json: string }>;
    expect(raw).toEqual([
      { event_type: "user", raw_json: '{"type":"user"}' },
      { event_type: "assistant", raw_json: '{"type":"assistant"}' },
    ]);
    const out = db.prepare(`SELECT output_text FROM tool_outputs`).get() as {
      output_text: string;
    };
    expect(out.output_text).toContain("full untruncated output");
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("extracts files_touched from codex apply_patch directives", () => {
    const db = openDb({ path: dbPath });
    const patch =
      "*** Begin Patch\n" +
      "*** Add File: /a/new.ts\n" +
      "+hello\n" +
      "*** Update File: /a/edit.ts\n" +
      "@@\n-old\n+new\n" +
      "*** Delete File: /a/gone.ts\n" +
      "*** End Patch\n";
    upsertSession(
      db,
      makeSession({
        id: `cx--${randomUUID()}`,
        source: "codex",
        messages: [
          { turn: 1, role: "user", text: "patch", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "apply_patch",
                args: patch,
                argsHash: "p1",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    const { files_touched } = runAllExtractors(db);
    expect(files_touched).toBe(3);
    const rows = db
      .prepare(`SELECT op, path FROM files_touched ORDER BY op, path`)
      .all() as Array<{ op: string; path: string }>;
    expect(rows).toEqual([
      { op: "delete", path: "/a/gone.ts" },
      { op: "edit", path: "/a/edit.ts" },
      { op: "write", path: "/a/new.ts" },
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("extracts files_touched from opencode patch file lists", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: `oc--${randomUUID()}`,
        source: "opencode",
        messages: [
          { turn: 1, role: "user", text: "patch", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "opencode_patch",
                args: {
                  hash: "abc123",
                  files: ["/a/edit.ts", "/a/also-edit.ts"],
                },
                argsHash: "ocp1",
                argsPreview: "",
                exitCode: 0,
              },
            ],
          },
        ],
      }),
    );
    const { files_touched } = runAllExtractors(db);
    expect(files_touched).toBe(2);
    const rows = db
      .prepare(`SELECT op, path FROM files_touched ORDER BY path`)
      .all() as Array<{ op: string; path: string }>;
    expect(rows).toEqual([
      { op: "edit", path: "/a/also-edit.ts" },
      { op: "edit", path: "/a/edit.ts" },
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("parses shell command head from Bash tool calls, strips wrappers", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        messages: [
          { turn: 1, role: "user", text: "do it", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Bash",
                args: { command: "git status" },
                argsHash: "a",
                argsPreview: "",
                exitCode: 0,
              },
              {
                name: "Bash",
                args: { command: "NODE_ENV=test npm test" },
                argsHash: "b",
                argsPreview: "",
                exitCode: 1,
              },
              {
                name: "Bash",
                args: { command: "sudo /usr/bin/systemctl restart foo" },
                argsHash: "c",
                argsPreview: "",
                exitCode: 0,
              },
            ],
          },
        ],
      }),
    );
    const { shell_commands } = runAllExtractors(db);
    expect(shell_commands).toBe(3);
    const heads = db
      .prepare(`SELECT cmd_head FROM shell_commands ORDER BY idx`)
      .all() as Array<{ cmd_head: string }>;
    expect(heads.map((r) => r.cmd_head)).toEqual(["git", "npm", "systemctl"]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("parses shell command head from codex exec_command tool calls", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: `cx--${randomUUID()}`,
        source: "codex",
        messages: [
          { turn: 1, role: "user", text: "", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "exec_command",
                args: { cmd: "git status --short" },
                argsHash: "x",
                argsPreview: "",
                exitCode: 0,
              },
              {
                name: "exec_command",
                args: { cmd: "pnpm vitest run" },
                argsHash: "y",
                argsPreview: "",
                exitCode: 1,
              },
            ],
          },
        ],
      }),
    );
    const { shell_commands } = runAllExtractors(db);
    expect(shell_commands).toBe(2);
    const heads = db
      .prepare(`SELECT cmd_head FROM shell_commands ORDER BY idx`)
      .all() as Array<{ cmd_head: string }>;
    expect(heads.map((r) => r.cmd_head)).toEqual(["git", "pnpm"]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("parses shell command head from execute_command tool calls", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        messages: [
          { turn: 1, role: "user", text: "", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "execute_command",
                args: { command: "npm run build" },
                argsHash: "x",
                argsPreview: "",
                exitCode: 0,
              },
            ],
          },
        ],
      }),
    );
    const { shell_commands } = runAllExtractors(db);
    expect(shell_commands).toBe(1);
    const row = db.prepare(`SELECT cmd_head FROM shell_commands`).get() as {
      cmd_head: string;
    };
    expect(row.cmd_head).toBe("npm");
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("extracts todo_events from CC TodoWrite, opencode todowrite, codex update_plan", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: `cc--${randomUUID()}`,
        source: "claude-code",
        messages: [
          { turn: 1, role: "user", text: "", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "TodoWrite",
                args: {
                  todos: [
                    { content: "a", status: "in_progress" },
                    { content: "b", status: "pending" },
                  ],
                },
                argsHash: "h1",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: `oc--${randomUUID()}`,
        source: "opencode",
        messages: [
          { turn: 1, role: "user", text: "", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "todowrite",
                args: { todos: [{ content: "x", status: "completed" }] },
                argsHash: "h2",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: `cx--${randomUUID()}`,
        source: "codex",
        messages: [
          { turn: 1, role: "user", text: "", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "update_plan",
                args: {
                  plan: [
                    { step: "p1", status: "in_progress" },
                    { step: "p2", status: "pending" },
                    { step: "p3", status: "completed" },
                  ],
                },
                argsHash: "h3",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    const { todo_events } = runAllExtractors(db);
    expect(todo_events).toBe(3);
    const totals = db
      .prepare(
        `SELECT total, pending, in_progress, completed FROM todo_events ORDER BY rowid`,
      )
      .all() as Array<{
      total: number;
      pending: number;
      in_progress: number;
      completed: number;
    }>;
    // Order matches insertion: cc 2, oc 1, cx 3
    expect(totals).toEqual([
      { total: 2, pending: 1, in_progress: 1, completed: 0 },
      { total: 1, pending: 0, in_progress: 0, completed: 1 },
      { total: 3, pending: 1, in_progress: 1, completed: 1 },
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("extracts search_calls from CC Grep + opencode grep/glob with patterns and paths", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: `cc--${randomUUID()}`,
        source: "claude-code",
        messages: [
          { turn: 1, role: "user", text: "", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Grep",
                args: {
                  pattern: "TODO\\(",
                  path: "/repo/src",
                  include: "*.ts",
                },
                argsHash: "h1",
                argsPreview: "",
              },
              {
                name: "Glob",
                args: { pattern: "**/*.test.ts", path: "/repo" },
                argsHash: "h2",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: `oc--${randomUUID()}`,
        source: "opencode",
        messages: [
          { turn: 1, role: "user", text: "", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "grep",
                args: { pattern: "useEffect", path: "/app", include: "*.tsx" },
                argsHash: "h3",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    const { search_calls } = runAllExtractors(db);
    expect(search_calls).toBe(3);
    const rows = db
      .prepare(
        `SELECT tool, pattern, path, include FROM search_calls ORDER BY tool, pattern`,
      )
      .all() as Array<{
      tool: string;
      pattern: string;
      path: string;
      include: string | null;
    }>;
    expect(rows).toEqual([
      { tool: "glob", pattern: "**/*.test.ts", path: "/repo", include: null },
      { tool: "grep", pattern: "TODO\\(", path: "/repo/src", include: "*.ts" },
      { tool: "grep", pattern: "useEffect", path: "/app", include: "*.tsx" },
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("extracts web_fetches search rows from codex web_search { queries }", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: `cx--${randomUUID()}`,
        source: "codex",
        messages: [
          { turn: 1, role: "user", text: "", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "web_search",
                args: { queries: ["site:foo.com bar baz", "alt query"] },
                argsHash: "h",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    runAllExtractors(db);
    const rows = db
      .prepare(`SELECT kind, query FROM web_fetches`)
      .all() as Array<{ kind: string; query: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("search");
    expect(rows[0]?.query).toBe("site:foo.com bar baz");
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("records tool_errors for non-zero exit tool calls with category", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        messages: [
          { turn: 1, role: "user", text: "", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Read",
                args: { file_path: "/none" },
                argsHash: "a",
                argsPreview: "",
                outputPreview: "Error: ENOENT no such file or directory",
                exitCode: 1,
              },
              {
                name: "Bash",
                args: { command: "foo" },
                argsHash: "b",
                argsPreview: "",
                outputPreview: "foo: command not found",
                exitCode: 127,
              },
              {
                name: "Edit",
                args: {},
                argsHash: "c",
                argsPreview: "",
                outputPreview:
                  "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
                exitCode: 1,
              },
              {
                name: "Edit",
                args: {},
                argsHash: "d",
                argsPreview: "",
                outputPreview:
                  "<tool_use_error>File has been modified since read, either by the user or by a linter.</tool_use_error>",
                exitCode: 1,
              },
              {
                name: "Edit",
                args: {},
                argsHash: "e",
                argsPreview: "",
                outputPreview:
                  "<tool_use_error>Found 2 matches of the string to replace, but replace_all is false.</tool_use_error>",
                exitCode: 1,
              },
              {
                name: "Bash",
                args: {},
                argsHash: "f",
                argsPreview: "",
                outputPreview:
                  "The user doesn't want to proceed with this tool use. The tool use was rejected.",
                exitCode: 1,
              },
              {
                name: "Bash",
                args: {},
                argsHash: "g",
                argsPreview: "",
                outputPreview: "Cancelled: parallel tool call Bash",
                exitCode: 1,
              },
              {
                name: "Bash",
                args: {},
                argsHash: "h",
                argsPreview: "",
                outputPreview:
                  "<tool_use_error>Blocked: sleep 30 followed by: tail</tool_use_error>",
                exitCode: 2,
              },
            ],
          },
        ],
      }),
    );
    const { tool_errors } = runAllExtractors(db);
    expect(tool_errors).toBe(8);
    const rows = db
      .prepare(`SELECT tool_name, error_category FROM tool_errors ORDER BY idx`)
      .all() as Array<{ tool_name: string; error_category: string }>;
    expect(rows).toEqual([
      { tool_name: "Read", error_category: "file_not_found" },
      { tool_name: "Bash", error_category: "not_found" },
      { tool_name: "Edit", error_category: "file_not_read" },
      { tool_name: "Edit", error_category: "file_modified_since_read" },
      { tool_name: "Edit", error_category: "string_not_unique" },
      { tool_name: "Bash", error_category: "user_rejected" },
      { tool_name: "Bash", error_category: "parallel_cancelled" },
      { tool_name: "Bash", error_category: "blocked_by_hook" },
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("records user_correction with preceding_turn + tool_calls count + followed_by_revert flag", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cc--fix-revert",
        contentHash: "h",
        messages: [
          {
            turn: 1,
            role: "user",
            text: "do some edits",
            ts: 1000,
            toolCalls: [],
          },
          {
            turn: 2,
            role: "assistant",
            text: "ok",
            ts: 1005,
            toolCalls: [
              {
                name: "Edit",
                args: { file_path: "/a/b.ts" },
                argsHash: "e1",
                argsPreview: "",
              },
              {
                name: "Edit",
                args: { file_path: "/a/c.ts" },
                argsHash: "e2",
                argsPreview: "",
              },
            ],
          },
          {
            turn: 3,
            role: "user",
            text: "no, revert that, it was wrong",
            ts: 1012,
            toolCalls: [],
          },
          {
            turn: 4,
            role: "assistant",
            text: "reverting",
            ts: 1015,
            toolCalls: [
              {
                name: "Bash",
                args: { command: "git restore /a/b.ts /a/c.ts" },
                argsHash: "s",
                argsPreview: "",
                exitCode: 0,
              },
            ],
          },
        ],
      }),
    );
    const { user_corrections } = runAllExtractors(db);
    expect(user_corrections).toBe(1);
    const row = db
      .prepare(
        `SELECT kind, preceding_turn, preceding_tool_calls, followed_by_revert, response_time_ms
           FROM user_corrections`,
      )
      .get() as {
      kind: string;
      preceding_turn: number;
      preceding_tool_calls: number;
      followed_by_revert: number;
      response_time_ms: number;
    };
    expect(row.kind).toBe("reject");
    expect(row.preceding_turn).toBe(2);
    expect(row.preceding_tool_calls).toBe(2);
    expect(row.followed_by_revert).toBe(1);
    expect(row.response_time_ms).toBe(7000);
    db.close();
    rmSync(dbPath, { force: true });
  });
});

describe("fact extractors", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  it("skills_invoked: extracts slug from Skill tool args and from SKILL.md path Reads", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        messages: [
          { turn: 1, role: "user", text: "use the skill", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Skill",
                args: { skill_id: "task-cli" },
                argsHash: "a",
                argsPreview: "",
              },
              {
                name: "Read",
                args: {
                  file_path: "/Users/u/.claude/skills/brainstorming/SKILL.md",
                },
                argsHash: "b",
                argsPreview: "",
              },
              {
                name: "skill_sample-plugin",
                args: {},
                argsHash: "c",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    runAllExtractors(db);
    const skills = db
      .prepare(`SELECT skill_name FROM skills_invoked ORDER BY skill_name`)
      .all() as Array<{ skill_name: string }>;
    expect(skills.map((r) => r.skill_name)).toEqual([
      "brainstorming",
      "sample-plugin",
      "task-cli",
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("mcp_calls: parses CallMcpTool args and mcp__server__tool / mcp_server_tool naming", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        messages: [
          { turn: 1, role: "user", text: "", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "CallMcpTool",
                args: { server: "tracker", toolName: "list_issues" },
                argsHash: "x",
                argsPreview: "",
              },
              {
                name: "mcp__wiki__get_page",
                args: {},
                argsHash: "y",
                argsPreview: "",
              },
              {
                name: "mcp_playwright_browser_click",
                args: {},
                argsHash: "z",
                argsPreview: "",
              },
              {
                name: "use_mcp_tool",
                args: { server_name: "linear", tool_name: "create_issue" },
                argsHash: "w",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    runAllExtractors(db);
    const rows = db
      .prepare(`SELECT server, tool FROM mcp_calls ORDER BY server, tool`)
      .all() as Array<{ server: string; tool: string }>;
    expect(rows).toEqual([
      { server: "linear", tool: "create_issue" },
      { server: "playwright", tool: "browser_click" },
      { server: "tracker", tool: "list_issues" },
      { server: "wiki", tool: "get_page" },
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("web_fetches: classifies WebFetch / WebSearch / browser_navigate", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        messages: [
          { turn: 1, role: "user", text: "", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "WebFetch",
                args: { url: "https://example.com/docs" },
                argsHash: "a",
                argsPreview: "",
              },
              {
                name: "WebSearch",
                args: { query: "rust borrow checker" },
                argsHash: "b",
                argsPreview: "",
              },
              {
                name: "browser_navigate",
                args: { url: "https://app.local/foo" },
                argsHash: "c",
                argsPreview: "",
              },
              // Read is not a web call; should not appear in web_fetches.
              {
                name: "Read",
                args: { file_path: "/a" },
                argsHash: "d",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    runAllExtractors(db);
    const rows = db
      .prepare(`SELECT kind, domain, query FROM web_fetches ORDER BY kind`)
      .all() as Array<{
      kind: string;
      domain: string | null;
      query: string | null;
    }>;
    expect(rows).toEqual([
      { kind: "fetch", domain: "example.com", query: null },
      { kind: "navigate", domain: "app.local", query: null },
      { kind: "search", domain: null, query: "rust borrow checker" },
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("git_operations: classifies common git subcommands and extracts branch/hash", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        messages: [
          { turn: 1, role: "user", text: "", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Bash",
                args: { command: "git status" },
                argsHash: "a",
                argsPreview: "",
                exitCode: 0,
              },
              {
                name: "Bash",
                args: { command: "git checkout main" },
                argsHash: "b",
                argsPreview: "",
                exitCode: 0,
              },
              {
                name: "Bash",
                args: { command: "git show 1234abcd5678" },
                argsHash: "c",
                argsPreview: "",
                exitCode: 0,
              },
              {
                name: "Bash",
                args: { command: "git commit -m foo" },
                argsHash: "d",
                argsPreview: "",
                exitCode: 0,
              },
              {
                name: "Bash",
                args: { command: "echo hi" },
                argsHash: "e",
                argsPreview: "",
                exitCode: 0,
              },
            ],
          },
        ],
      }),
    );
    runAllExtractors(db);
    const rows = db
      .prepare(
        `SELECT op, branch, commit_hash FROM git_operations ORDER BY idx`,
      )
      .all() as Array<{
      op: string;
      branch: string | null;
      commit_hash: string | null;
    }>;
    expect(rows).toEqual([
      { op: "status", branch: null, commit_hash: null },
      { op: "checkout", branch: "main", commit_hash: null },
      { op: "show", branch: null, commit_hash: "1234abcd5678" },
      { op: "commit", branch: null, commit_hash: null },
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("todo_events: counts statuses from TodoWrite args.todos", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        messages: [
          { turn: 1, role: "user", text: "", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "TodoWrite",
                args: {
                  todos: [
                    { id: "a", content: "first", status: "completed" },
                    { id: "b", content: "second", status: "in_progress" },
                    { id: "c", content: "third", status: "pending" },
                    { id: "d", content: "fourth", status: "pending" },
                  ],
                },
                argsHash: "x",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    runAllExtractors(db);
    const row = db
      .prepare(
        `SELECT total, pending, in_progress, completed, cancelled FROM todo_events`,
      )
      .get() as {
      total: number;
      pending: number;
      in_progress: number;
      completed: number;
      cancelled: number;
    };
    expect(row).toEqual({
      total: 4,
      pending: 2,
      in_progress: 1,
      completed: 1,
      cancelled: 0,
    });
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("user_interruptions: catches a fast short user turn after a busy assistant turn", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cc--int-1",
        messages: [
          {
            turn: 1,
            role: "user",
            text: "do everything",
            ts: 1000,
            toolCalls: [],
          },
          {
            turn: 2,
            role: "assistant",
            text: "ok",
            ts: 1010,
            toolCalls: [
              {
                name: "Bash",
                args: { command: "ls" },
                argsHash: "a",
                argsPreview: "",
              },
              {
                name: "Bash",
                args: { command: "pwd" },
                argsHash: "b",
                argsPreview: "",
              },
              {
                name: "Bash",
                args: { command: "whoami" },
                argsHash: "c",
                argsPreview: "",
              },
              {
                name: "Bash",
                args: { command: "uname" },
                argsHash: "d",
                argsPreview: "",
              },
            ],
          },
          { turn: 3, role: "user", text: "stop", ts: 1012, toolCalls: [] },
        ],
      }),
    );
    runAllExtractors(db);
    const rows = db
      .prepare(
        `SELECT turn, response_time_ms, reason_hint FROM user_interruptions`,
      )
      .all() as Array<{
      turn: number;
      response_time_ms: number;
      reason_hint: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.turn).toBe(3);
    expect(rows[0]?.response_time_ms).toBe(2000);
    expect(rows[0]?.reason_hint).toBe("correction");
    db.close();
    rmSync(dbPath, { force: true });
  });
});

describe("pattern extractors", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  it("tool_call_ngrams: aggregates n=2/3/4 sequences across sessions, threshold 3", () => {
    const db = openDb({ path: dbPath });
    // Three sessions each with the sequence Read → Edit → Bash.
    for (let i = 0; i < 3; i += 1) {
      upsertSession(
        db,
        makeSession({
          id: `cc--ng-${i}`,
          contentHash: `h${i}`,
          messages: [
            { turn: 1, role: "user", text: "go", toolCalls: [] },
            {
              turn: 2,
              role: "assistant",
              text: "",
              toolCalls: [
                {
                  name: "Read",
                  args: { file_path: "/a" },
                  argsHash: "r",
                  argsPreview: "",
                },
                {
                  name: "Edit",
                  args: { file_path: "/a" },
                  argsHash: "e",
                  argsPreview: "",
                },
                {
                  name: "Bash",
                  args: { command: "ls" },
                  argsHash: "b",
                  argsPreview: "",
                },
              ],
            },
          ],
        }),
      );
    }
    runAllExtractors(db);
    const rows = db
      .prepare(
        `SELECT sequence, n, count, sessions FROM tool_call_ngrams WHERE n = 3 ORDER BY count DESC`,
      )
      .all() as Array<{
      sequence: string;
      n: number;
      count: number;
      sessions: number;
    }>;
    const triple = rows.find((r) => r.sequence === "Read → Edit → Bash");
    expect(triple).toBeDefined();
    expect(triple?.count).toBe(3);
    expect(triple?.sessions).toBe(3);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("prompt_templates: groups normalized first-prompts with count >= 3", () => {
    const db = openDb({ path: dbPath });
    for (let i = 0; i < 3; i += 1) {
      upsertSession(
        db,
        makeSession({
          id: `cc--pt-${i}`,
          contentHash: `h${i}`,
          messages: [
            {
              turn: 1,
              role: "user",
              text: `please run the tests in /Users/u/proj/${i}/test_${i + 100}.ts`,
              toolCalls: [],
            },
            { turn: 2, role: "assistant", text: "ok", toolCalls: [] },
          ],
        }),
      );
    }
    runAllExtractors(db);
    const rows = db
      .prepare(`SELECT template, count FROM prompt_templates`)
      .all() as Array<{ template: string; count: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
    expect(rows[0]?.template).toContain("<path>");
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("prompt_templates: drops sessions whose first prompt is injected noise", () => {
    const db = openDb({ path: dbPath });
    // 3 sessions whose first turn is a skill-body echo — without the filter
    // these would group into a single high-count template and dominate
    // `top prompts`. With the filter they drop out entirely.
    for (let i = 0; i < 3; i += 1) {
      upsertSession(
        db,
        makeSession({
          id: `cc--noise-prompt-${i}`,
          contentHash: `np${i}`,
          messages: [
            {
              turn: 1,
              role: "user",
              text: `Base directory for this skill: /home/u/.claude/skills/foo-${i}\n\n# Foo\n\nrun the tests`,
              toolCalls: [],
            },
            { turn: 2, role: "assistant", text: "ok", toolCalls: [] },
          ],
        }),
      );
    }
    runAllExtractors(db);
    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM prompt_templates`).get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(0);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("friction_events: detects retry_same_cmd and tool_error_loop on synthetic data", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cc--frict-1",
        messages: [
          { turn: 1, role: "user", text: "go", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Bash",
                args: { command: "./dev.py start" },
                argsHash: "a",
                argsPreview: "",
                exitCode: 1,
              },
              {
                name: "Bash",
                args: { command: "./dev.py start" },
                argsHash: "b",
                argsPreview: "",
                exitCode: 1,
              },
              {
                name: "Bash",
                args: { command: "./dev.py start" },
                argsHash: "c",
                argsPreview: "",
                exitCode: 1,
              },
            ],
          },
        ],
      }),
    );
    runAllExtractors(db);
    const types = db
      .prepare(`SELECT type, COUNT(*) AS n FROM friction_events GROUP BY type`)
      .all() as Array<{ type: string; n: number }>;
    const byType: Record<string, number> = {};
    for (const r of types) byType[r.type] = r.n;
    expect(byType.retry_same_cmd).toBeGreaterThanOrEqual(1);
    expect(byType.tool_error_loop).toBe(1);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("self_resolutions: detects same args_hash failed-then-ok with no user turn between", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cc--sr-1",
        contentHash: "h1",
        messages: [
          {
            turn: 1,
            role: "user",
            text: "start the dev server",
            toolCalls: [],
          },
          {
            turn: 2,
            role: "assistant",
            text: "trying",
            toolCalls: [
              {
                name: "Bash",
                args: { command: "./dev.py start" },
                argsHash: "fix-hash",
                argsPreview: "./dev.py start",
                exitCode: 1,
              },
            ],
          },
          {
            turn: 3,
            role: "assistant",
            text: "checking why it failed",
            toolCalls: [
              {
                name: "Bash",
                args: { command: "colima status" },
                argsHash: "diag-1",
                argsPreview: "colima status",
                exitCode: 0,
              },
            ],
          },
          {
            turn: 4,
            role: "assistant",
            text: "stale mount, restarting colima",
            toolCalls: [
              {
                name: "Bash",
                args: { command: "colima restart" },
                argsHash: "diag-2",
                argsPreview: "colima restart",
                exitCode: 0,
              },
            ],
          },
          {
            turn: 5,
            role: "assistant",
            text: "now retry",
            toolCalls: [
              {
                name: "Bash",
                args: { command: "./dev.py start" },
                argsHash: "fix-hash",
                argsPreview: "./dev.py start",
                exitCode: 0,
              },
            ],
          },
        ],
      }),
    );
    runAllExtractors(db);
    const rows = db
      .prepare(
        `SELECT fail_turn, ok_turn, gap_turns, tool_name, args_hash,
                resolution_tool_calls_json, resolution_reasoning_json
           FROM self_resolutions`,
      )
      .all() as Array<{
      fail_turn: number;
      ok_turn: number;
      gap_turns: number;
      tool_name: string;
      args_hash: string;
      resolution_tool_calls_json: string;
      resolution_reasoning_json: string;
    }>;
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.fail_turn).toBe(2);
    expect(r.ok_turn).toBe(5);
    expect(r.gap_turns).toBe(3);
    expect(r.tool_name).toBe("Bash");
    const intermediates = JSON.parse(r.resolution_tool_calls_json) as Array<{
      name: string;
    }>;
    expect(intermediates.map((i) => i.name)).toEqual(["Bash", "Bash"]);
    const reasoning = JSON.parse(r.resolution_reasoning_json) as Array<{
      text: string;
    }>;
    expect(reasoning.length).toBe(2);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("self_resolutions: skips pairs where a user turn intervenes", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cc--sr-2",
        contentHash: "h2",
        messages: [
          { turn: 1, role: "user", text: "go", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Bash",
                args: { command: "x" },
                argsHash: "h",
                argsPreview: "x",
                exitCode: 1,
              },
            ],
          },
          { turn: 3, role: "user", text: "try with sudo", toolCalls: [] },
          {
            turn: 4,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Bash",
                args: { command: "x" },
                argsHash: "h",
                argsPreview: "x",
                exitCode: 0,
              },
            ],
          },
        ],
      }),
    );
    runAllExtractors(db);
    const n = (
      db.prepare(`SELECT COUNT(*) AS n FROM self_resolutions`).get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(0);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("subagent_invocations: one row per Task tool call; child linked when parent_session_id matches", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cc--parent",
        contentHash: "p",
        messages: [
          { turn: 1, role: "user", text: "delegate", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Task",
                args: {
                  subagent_type: "explore",
                  prompt: "find all api endpoints",
                },
                argsHash: "t",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "cc--child",
        contentHash: "c",
        parentSessionId: "cc--parent",
        messages: [
          {
            turn: 1,
            role: "user",
            text: "find all api endpoints",
            toolCalls: [],
          },
        ],
      }),
    );
    runAllExtractors(db);
    const rows = db
      .prepare(
        `SELECT parent_session_id, child_session_id, subagent_type, task_text
           FROM subagent_invocations`,
      )
      .all() as Array<{
      parent_session_id: string;
      child_session_id: string | null;
      subagent_type: string;
      task_text: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.parent_session_id).toBe("cc--parent");
    expect(rows[0]?.child_session_id).toBe("cc--child");
    expect(rows[0]?.subagent_type).toBe("explore");
    expect(rows[0]?.task_text).toBe("find all api endpoints");
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("subagent_invocations: also extracts from the newer Agent tool name", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cc--parent-agent",
        contentHash: "pa",
        messages: [
          { turn: 1, role: "user", text: "delegate", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Agent",
                args: {
                  subagent_type: "sample-plugin:reviewer",
                  description: "review the implementation",
                  prompt: "Review the input for correctness",
                },
                argsHash: "a1",
                argsPreview: "",
              },
              {
                name: "Agent",
                args: {
                  subagent_type: "general-purpose",
                  prompt: "explore the codebase for usages of foo",
                },
                argsHash: "a2",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    runAllExtractors(db);
    const rows = db
      .prepare(
        `SELECT subagent_type, task_text
           FROM subagent_invocations
          WHERE parent_session_id = 'cc--parent-agent'
          ORDER BY idx`,
      )
      .all() as Array<{ subagent_type: string; task_text: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.subagent_type).toBe("sample-plugin:reviewer");
    expect(rows[0]?.task_text).toBe("Review the input for correctness");
    expect(rows[1]?.subagent_type).toBe("general-purpose");
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("subagent_invocations: links Codex spawn_agent by id, task path, then deterministic fallback", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cx--parent",
        source: "codex",
        contentHash: "codex-parent",
        messages: [
          { turn: 1, role: "user", text: "delegate", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "spawn_agent",
                args: { agent_type: "explorer", message: "old protocol" },
                argsHash: "old",
                argsPreview: "",
                outputFull: JSON.stringify({ agent_id: "old-child" }),
              },
              {
                name: "spawn_agent",
                args: { task_name: "audit", message: "new protocol" },
                argsHash: "new",
                argsPreview: "",
                outputFull: JSON.stringify({ agent_id: "new-child" }),
              },
              {
                name: "spawn_agent",
                args: { task_name: "nested", message: "match by path" },
                argsHash: "path",
                argsPreview: "",
              },
              {
                name: "spawn_agent",
                args: { message: "ordered fallback" },
                argsHash: "fallback",
                argsPreview: "",
              },
              {
                name: "spawn_agent",
                args: {
                  task_name: "opaque_task",
                  message: `gAAAA${"A".repeat(96)}`,
                },
                argsHash: "opaque",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );

    for (const child of [
      {
        id: "cx--guardian",
        externalId: "guardian",
        agentType: "guardian",
        startedAt: 1,
      },
      {
        id: "cx--old-child",
        externalId: "old-child",
        agentType: "explorer",
        startedAt: 2,
      },
      {
        id: "cx--new-child",
        externalId: "new-child",
        agentType: "/root/audit",
        startedAt: 3,
      },
      {
        id: "cx--path-child",
        externalId: "path-child",
        agentType: "/root/nested",
        startedAt: 4,
      },
      {
        id: "cx--fallback-child",
        externalId: "fallback-child",
        startedAt: 5,
      },
      {
        id: "cx--opaque-child",
        externalId: "opaque-child",
        agentType: "/root/opaque_task",
        startedAt: 6,
      },
    ]) {
      upsertSession(
        db,
        makeSession({
          ...child,
          source: "codex",
          parentSessionId: "cx--parent",
          contentHash: child.id,
        }),
      );
    }

    runAllExtractors(db);
    runAllExtractors(db);

    const workflowCount = db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM workflow_runs`,
      )
      .get();
    expect(workflowCount?.count).toBe(0);

    const rows = db
      .prepare(
        `SELECT idx, child_session_id, subagent_type, task_text
           FROM subagent_invocations
          WHERE parent_session_id = 'cx--parent'
          ORDER BY idx`,
      )
      .all() as Array<{
      idx: number;
      child_session_id: string | null;
      subagent_type: string | null;
      task_text: string;
    }>;
    expect(rows).toEqual([
      {
        idx: 0,
        child_session_id: "cx--old-child",
        subagent_type: "explorer",
        task_text: "old protocol",
      },
      {
        idx: 1,
        child_session_id: "cx--new-child",
        subagent_type: "audit",
        task_text: "new protocol",
      },
      {
        idx: 2,
        child_session_id: "cx--path-child",
        subagent_type: "nested",
        task_text: "match by path",
      },
      {
        idx: 3,
        child_session_id: "cx--fallback-child",
        subagent_type: null,
        task_text: "ordered fallback",
      },
      {
        idx: 4,
        child_session_id: "cx--opaque-child",
        subagent_type: "opaque_task",
        task_text: "opaque_task",
      },
    ]);
    expect(rows.some((row) => row.child_session_id === "cx--guardian")).toBe(
      false,
    );

    const rollup = db
      .prepare<[string], { has_subagents: number; subagent_count: number }>(
        `SELECT has_subagents, subagent_count FROM sessions WHERE id = ?`,
      )
      .get("cx--parent");
    expect(rollup).toEqual({ has_subagents: 1, subagent_count: 6 });
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("subagent_invocations: reserves a later exact child before fallback matching", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cx--reservation-parent",
        source: "codex",
        contentHash: "reservation-parent",
        messages: [
          {
            turn: 1,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "spawn_agent",
                args: { agent_type: "worker", message: "failed first" },
                argsHash: "failed",
                argsPreview: "",
                outputFull: "spawn failed",
              },
              {
                name: "spawn_agent",
                args: { agent_type: "worker", message: "successful second" },
                argsHash: "success",
                argsPreview: "",
                outputFull: JSON.stringify({ agent_id: "reserved-child" }),
              },
            ],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "cx--reserved-child",
        externalId: "reserved-child",
        source: "codex",
        parentSessionId: "cx--reservation-parent",
        agentType: "worker",
        startedAt: 10,
        contentHash: "reserved-child",
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "cx--reservation-guardian",
        source: "codex",
        parentSessionId: "cx--reservation-parent",
        agentType: "guardian",
        startedAt: 11,
        contentHash: "reservation-guardian",
      }),
    );

    runAllExtractors(db);
    const rows = db
      .prepare(
        `SELECT idx, child_session_id
           FROM subagent_invocations
          WHERE parent_session_id = 'cx--reservation-parent'
          ORDER BY idx`,
      )
      .all() as Array<{ idx: number; child_session_id: string | null }>;
    expect(rows).toEqual([
      { idx: 0, child_session_id: null },
      { idx: 1, child_session_id: "cx--reserved-child" },
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("subagent_invocations: a failed path dispatch cannot claim a later successful child", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cx--path-retry-parent",
        source: "codex",
        contentHash: "path-retry-parent",
        messages: [
          {
            turn: 1,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "spawn_agent",
                args: { task_name: "audit", message: "first attempt" },
                argsHash: "failed-path",
                argsPreview: "",
                outputFull: "collab spawn failed: agent thread limit reached",
              },
              {
                name: "spawn_agent",
                args: { task_name: "audit", message: "retry" },
                argsHash: "successful-path",
                argsPreview: "",
                outputFull: JSON.stringify({ task_name: "/root/audit" }),
              },
            ],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "cx--path-retry-child",
        source: "codex",
        parentSessionId: "cx--path-retry-parent",
        agentType: "/root/audit",
        startedAt: 10,
        contentHash: "path-retry-child",
      }),
    );

    runAllExtractors(db);
    const rows = db
      .prepare(
        `SELECT idx, child_session_id FROM subagent_invocations
          WHERE parent_session_id = 'cx--path-retry-parent' ORDER BY idx`,
      )
      .all() as Array<{ idx: number; child_session_id: string | null }>;
    expect(rows).toEqual([
      { idx: 0, child_session_id: null },
      { idx: 1, child_session_id: "cx--path-retry-child" },
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("subagent_invocations: a non-Codex agent named guardian remains linkable", () => {
    const db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cc--guardian-parent",
        contentHash: "guardian-parent",
        messages: [
          {
            turn: 1,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Task",
                args: {
                  subagent_type: "guardian",
                  prompt: "Review the synthetic change",
                },
                argsHash: "guardian-task",
                argsPreview: "",
              },
            ],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "cc--guardian-child",
        parentSessionId: "cc--guardian-parent",
        agentType: "guardian",
        contentHash: "guardian-child",
      }),
    );

    runAllExtractors(db);
    const row = db
      .prepare(
        `SELECT child_session_id FROM subagent_invocations
          WHERE parent_session_id = 'cc--guardian-parent'`,
      )
      .get() as { child_session_id: string | null } | undefined;
    expect(row?.child_session_id).toBe("cc--guardian-child");
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("skills_available: parses skill_listing attachments from raw_events", () => {
    const db = openDb({ path: dbPath });
    const listing = {
      type: "attachment",
      attachment: {
        type: "skill_listing",
        skillCount: 2,
        isInitial: true,
        content: `- task-cli: Use task CLI
- superpowers:brainstorming: Explore before coding`,
      },
    };
    upsertSession(
      db,
      makeSession({
        id: "cc--skills-available",
        messages: [],
        rawEvents: [
          {
            seq: 10,
            eventType: "attachment",
            rawJson: JSON.stringify(listing),
          },
        ],
      }),
    );
    runAllExtractors(db);
    const rows = db
      .prepare(
        `SELECT skill_name, description, origin, is_initial FROM skills_available ORDER BY skill_name`,
      )
      .all() as Array<{
      skill_name: string;
      description: string;
      origin: string;
      is_initial: number;
    }>;
    expect(rows).toEqual([
      {
        skill_name: "superpowers:brainstorming",
        description: "Explore before coding",
        origin: "unknown",
        is_initial: 1,
      },
      {
        skill_name: "task-cli",
        description: "Use task CLI",
        origin: "unknown",
        is_initial: 1,
      },
    ]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("skills_available: skips malformed raw_events before SQLite json_extract", () => {
    const db = openDb({ path: dbPath });
    const listing = {
      type: "attachment",
      attachment: {
        type: "skill_listing",
        isInitial: true,
        content: "- task-cli: Use task CLI",
      },
    };
    upsertSession(
      db,
      makeSession({
        id: "cc--skills-available-malformed",
        messages: [],
        rawEvents: [
          {
            seq: 1,
            eventType: "assistant",
            rawJson: '{"type":"assistant"}{"type":"assistant"}',
          },
          {
            seq: 2,
            eventType: "attachment",
            rawJson: JSON.stringify(listing),
          },
        ],
      }),
    );

    expect(() => runAllExtractors(db)).not.toThrow();
    const rows = db
      .prepare(`SELECT skill_name FROM skills_available ORDER BY skill_name`)
      .all() as Array<{ skill_name: string }>;
    expect(rows).toEqual([{ skill_name: "task-cli" }]);
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("skills shelf views: join loaded catalog with tool + hook usage", () => {
    const db = openDb({ path: dbPath });
    const listing = {
      type: "attachment",
      attachment: {
        type: "skill_listing",
        isInitial: true,
        content: `- task-cli: Task ops
- superpowers:brainstorming: Explore
- simplify: Review diffs`,
      },
    };
    upsertSession(
      db,
      makeSession({
        id: "cc--skills-shelf",
        messages: [
          { turn: 1, role: "user", text: "go", toolCalls: [] },
          {
            turn: 2,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Skill",
                args: { skill_id: "task-cli" },
                argsHash: "a",
                argsPreview: "",
              },
            ],
          },
          {
            turn: 3,
            role: "user",
            text: "Base directory for this skill: /Users/u/.claude/plugins/cache/superpowers/5.0.2/skills/brainstorming/SKILL.md\n\n# Brainstorm",
            toolCalls: [],
          },
        ],
        rawEvents: [
          { seq: 4, eventType: "attachment", rawJson: JSON.stringify(listing) },
        ],
      }),
    );
    runAllExtractors(db);

    const shelf = db
      .prepare(
        `SELECT skills_loaded, skills_used, skills_unused, pct_used FROM v_session_skill_shelf`,
      )
      .get() as {
      skills_loaded: number;
      skills_used: number;
      skills_unused: number;
      pct_used: number;
    };
    expect(shelf).toEqual({
      skills_loaded: 3,
      skills_used: 2,
      skills_unused: 1,
      pct_used: 66.7,
    });

    const unused = db
      .prepare(
        `SELECT skill_name FROM v_skills_available_usage WHERE was_used = 0`,
      )
      .all() as Array<{ skill_name: string }>;
    expect(unused.map((r) => r.skill_name)).toEqual(["simplify"]);

    db.close();
    rmSync(dbPath, { force: true });
  });
});
