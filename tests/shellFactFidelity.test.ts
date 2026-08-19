import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CanonicalSession } from "../src/adapters/types.js";
import { openDb } from "../src/db/client.js";
import { upsertSessionWithPayload } from "../src/db/writer.js";
import { runAllExtractors } from "../src/extract/index.js";

/**
 * Regression coverage for three fact-fidelity bugs: each one fabricated or lost
 * a fact by reading command text as text instead of as shell.
 *
 *   - shell.ts   a quoted shell metacharacter cut the command short, so
 *                `cmd_head` fell into the NULL bucket
 *   - commit.ts  `cmd_full LIKE '%git commit%'` counted a command that merely
 *                mentioned the phrase as the session's latest commit
 *   - friction.ts a composite key was split back apart, truncating any path
 *                containing the separator
 */

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

interface ShellInvocation {
  command: string;
  exitCode?: number;
  /** The source reported no exit code at all, as cursor transcripts do. */
  noExitCode?: boolean;
}

/** Run each command as its own Bash tool call in one turn against a fresh corpus. */
function withExtractedSession<T>(
  invocations: ShellInvocation[],
  read: (db: ReturnType<typeof openDb>, sessionId: string) => T,
  sessionOverrides: Partial<CanonicalSession> = {},
): T {
  const dbPath = tmpDbPath();
  const db = openDb({ path: dbPath });
  const session = makeSession(sessionOverrides);
  upsertSessionWithPayload(
    db,
    makeSession({
      ...session,
      messages: [
        { turn: 1, role: "user", text: "run commands", toolCalls: [] },
        {
          turn: 2,
          role: "assistant",
          text: "",
          toolCalls: invocations.map((invocation, i) => ({
            name: "Bash",
            args: { command: invocation.command },
            argsHash: `h${i}`,
            argsPreview: "",
            exitCode: invocation.noExitCode
              ? undefined
              : (invocation.exitCode ?? 0),
          })),
        },
      ],
    }),
  );
  runAllExtractors(db);
  const result = read(db, session.id);
  db.close();
  rmSync(dbPath, { force: true });
  return result;
}

function headsFor(commands: string[]): Array<string | null> {
  return withExtractedSession(
    commands.map((command) => ({ command })),
    (db) =>
      (
        db
          .prepare(`SELECT cmd_head FROM shell_commands ORDER BY idx`)
          .all() as Array<{ cmd_head: string | null }>
      ).map((r) => r.cmd_head),
  );
}

interface CommitFlags {
  ended_with_commit: number;
  ended_with_commit_attempted: number;
}

function commitFlagsFor(
  invocations: ShellInvocation[],
  source = "claude-code",
): CommitFlags {
  return withExtractedSession(
    invocations,
    (db, sessionId) =>
      db
        .prepare(
          `SELECT ended_with_commit, ended_with_commit_attempted FROM sessions WHERE id = ?`,
        )
        .get(sessionId) as CommitFlags,
    { source, id: `${source === "cursor" ? "cu" : "cc"}--${randomUUID()}` },
  );
}

describe("cmd_head: derived from a parse, not a whitespace split", () => {
  it("finds the command word behind an assignment whose value contains a quoted semicolon", () => {
    // Both of these used to be cut at the quoted `;`, leaving a fragment that
    // looked like a bare assignment, and stored a NULL head.
    expect(headsFor(["IFS=';' read -r a b"])).toEqual(["read"]);
    expect(headsFor(['PGPASSWORD="a;b" psql -c "select 1"'])).toEqual(["psql"]);
  });

  it("is not confused by a shell metacharacter inside a quoted argument", () => {
    expect(
      headsFor([
        'rg "foo|bar" src/',
        'echo "a > b"',
        "awk '{print $1; print $2}' file",
      ]),
    ).toEqual(["rg", "echo", "awk"]);
  });

  it("takes the head of the first command in a compound, not of the whole string", () => {
    expect(
      headsFor(["pnpm build && pnpm test", "git status; git diff"]),
    ).toEqual(["pnpm", "git"]);
  });

  it("still strips wrappers, assignments, and path prefixes", () => {
    expect(
      headsFor([
        "NODE_ENV=test npm test",
        "sudo /usr/bin/systemctl restart foo",
        "env FOO=bar git status",
      ]),
    ).toEqual(["npm", "systemctl", "git"]);
  });

  it("looks past a leading assignment-only statement to the command that follows", () => {
    // The dominant multi-statement shape in the corpus: a script sets a path
    // variable on its own line before using it. That first statement carries no
    // command word at all, so the script's head is the next command's.
    expect(
      headsFor([
        ["WT=/srv/checkout/wt", 'git -C "$WT" status'].join("\n"),
        ["A=~/proj", "B=$A/src", 'cd "$B"', "pnpm test"].join("\n"),
      ]),
    ).toEqual(["git", "cd"]);
  });

  it("stores no head for a loop, whose body is outside the reachable scope", () => {
    // `for` is a shell keyword, not a program: reporting it as a command head
    // invented a command that never ran. The body is deliberately not walked
    // (see shellParse.ts), so the head is absent instead.
    expect(headsFor(["for f in *.ts; do echo $f; done"])).toEqual([null]);
  });

  it("stores no head for a command that does not parse, but keeps the command itself", () => {
    const rows = withExtractedSession(
      [{ command: 'git commit -m "unterminated' }],
      (db) =>
        db
          .prepare(`SELECT cmd_head, cmd_full FROM shell_commands`)
          .all() as Array<{ cmd_head: string | null; cmd_full: string }>,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cmd_head).toBeNull();
    expect(rows[0]!.cmd_full).toBe('git commit -m "unterminated');
  });

  it("recovers git operations that the split used to hide behind a quoted metacharacter", () => {
    // `cmd_head` gates git.ts, so a lost head lost the whole session's git ops.
    const ops = withExtractedSession(
      [{ command: 'GIT_TRACE="a;b" git commit -m "x"' }],
      (db) =>
        db
          .prepare(`SELECT op FROM git_operations ORDER BY idx`)
          .all() as Array<{
          op: string;
        }>,
    );
    expect(ops.map((r) => r.op)).toEqual(["commit"]);
  });
});

describe("ended_with_commit: derived from the git fact table, not a text match", () => {
  it("keeps a successful commit when a later command merely mentions the phrase", () => {
    expect(
      commitFlagsFor([
        { command: 'git commit -m "feat: thing"', exitCode: 0 },
        { command: 'grep -rn "git commit" docs/', exitCode: 1 },
      ]),
    ).toEqual({ ended_with_commit: 1, ended_with_commit_attempted: 0 });
  });

  it("keeps a successful commit when a later commit message quotes the phrase", () => {
    expect(
      commitFlagsFor([
        {
          command: 'git commit -m "docs: explain git commit failures"',
          exitCode: 0,
        },
        { command: 'echo "run git commit next time" >> notes.md', exitCode: 1 },
      ]),
    ).toEqual({ ended_with_commit: 1, ended_with_commit_attempted: 0 });
  });

  it("still reports a failed commit as not committed", () => {
    expect(
      commitFlagsFor([{ command: 'git commit -m "x"', exitCode: 1 }]),
    ).toEqual({ ended_with_commit: 0, ended_with_commit_attempted: 0 });
  });

  it("uses the last real commit when several ran", () => {
    expect(
      commitFlagsFor([
        { command: 'git commit -m "first"', exitCode: 0 },
        { command: 'git commit -m "second"', exitCode: 1 },
      ]),
    ).toEqual({ ended_with_commit: 0, ended_with_commit_attempted: 0 });
  });

  it("records an attempt rather than a commit for a source without exit codes", () => {
    expect(
      commitFlagsFor(
        [{ command: 'git commit -m "x"', noExitCode: true }],
        "cursor",
      ),
    ).toEqual({ ended_with_commit: 0, ended_with_commit_attempted: 1 });
  });

  it("records nothing when no commit ran, however often the phrase appears", () => {
    expect(
      commitFlagsFor([
        { command: 'grep -rn "git commit" docs/', exitCode: 0 },
        { command: 'echo "git commit -m x"', exitCode: 0 },
      ]),
    ).toEqual({ ended_with_commit: 0, ended_with_commit_attempted: 0 });
  });
});

describe("repeated_file_read: the reported path is the path that was read", () => {
  it("reports a path containing the grouping separator in full", () => {
    const path = "/tmp/proj/src/traits/Iterator::next.rs";
    const dbPath = tmpDbPath();
    const db = openDb({ path: dbPath });
    upsertSessionWithPayload(
      db,
      makeSession({
        messages: [
          { turn: 1, role: "user", text: "read it", toolCalls: [] },
          ...[2, 3, 4, 5].map((turn) => ({
            turn,
            role: "assistant" as const,
            text: "",
            toolCalls: [
              {
                name: "Read",
                args: { file_path: path },
                argsHash: `h${turn}`,
                argsPreview: "",
                exitCode: 0,
              },
            ],
          })),
        ],
      }),
    );
    runAllExtractors(db);
    const rows = db
      .prepare(
        `SELECT context FROM friction_events WHERE type = 'repeated_file_read'`,
      )
      .all() as Array<{ context: string }>;
    db.close();
    rmSync(dbPath, { force: true });
    expect(rows).toEqual([{ context: `${path} (4 reads)` }]);
  });
});
