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
 * Regression coverage for the git.ts quoting/heredoc fabrication bug: a
 * shell operator or the word "git" found inside a quoted string or a
 * heredoc body must never produce a git_operations row, because that row
 * would describe a command that never ran. See src/extract/git.ts for the
 * governing "a missing row is better than a wrong row" principle.
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

interface GitOpRow {
  op: string;
  branch: string | null;
  commit_hash: string | null;
}

/** Run each `command` as its own Bash tool call in one turn, then return the resulting git_operations rows in insertion order. */
function extractGitOpsFor(commands: string[]): GitOpRow[] {
  const dbPath = tmpDbPath();
  const db = openDb({ path: dbPath });
  upsertSessionWithPayload(
    db,
    makeSession({
      messages: [
        { turn: 1, role: "user", text: "run commands", toolCalls: [] },
        {
          turn: 2,
          role: "assistant",
          text: "",
          toolCalls: commands.map((command, i) => ({
            name: "Bash",
            args: { command },
            argsHash: `h${i}`,
            argsPreview: "",
            exitCode: 0,
          })),
        },
      ],
    }),
  );
  runAllExtractors(db);
  const rows = db
    .prepare(`SELECT op, branch, commit_hash FROM git_operations ORDER BY idx`)
    .all() as GitOpRow[];
  db.close();
  rmSync(dbPath, { force: true });
  return rows;
}

describe("git_operations: quote and heredoc awareness", () => {
  it("records exactly one commit, not a phantom push, when the commit message text mentions a second git command", () => {
    const rows = extractGitOpsFor([
      'git commit -m "Refactor auth module; also run git push to deploy"',
    ]);
    expect(rows).toEqual([{ op: "commit", branch: null, commit_hash: null }]);
  });

  it("does not parse a heredoc body as git operations, even one that mentions another git subcommand", () => {
    const cmd = [
      "git commit -q --amend -F - <<'EOF'",
      "feat: update parser",
      "git log entries mentioned here for testing",
      "EOF",
    ].join("\n");
    const rows = extractGitOpsFor([cmd]);
    expect(rows).toEqual([{ op: "commit", branch: null, commit_hash: null }]);
  });

  it("records only the outer commit when a command substitution's heredoc body mentions git push", () => {
    const cmd = [
      "git commit -m \"$(cat <<'EOF'",
      "feat: thing",
      "git push origin main",
      "EOF",
      ')"',
    ].join("\n");
    const rows = extractGitOpsFor([cmd]);
    expect(rows).toEqual([{ op: "commit", branch: null, commit_hash: null }]);
  });

  it("splits a && compound into add then commit", () => {
    const rows = extractGitOpsFor(['git add . && git commit -m "x"']);
    expect(rows).toEqual([
      { op: "add", branch: null, commit_hash: null },
      { op: "commit", branch: null, commit_hash: null },
    ]);
  });

  it("splits a second && compound into commit then push", () => {
    const rows = extractGitOpsFor(['git commit -m "x" && git push']);
    expect(rows).toEqual([
      { op: "commit", branch: null, commit_hash: null },
      { op: "push", branch: null, commit_hash: null },
    ]);
  });

  it("splits a ; compound into status then diff", () => {
    const rows = extractGitOpsFor(["git status; git diff"]);
    expect(rows).toEqual([
      { op: "status", branch: null, commit_hash: null },
      { op: "diff", branch: null, commit_hash: null },
    ]);
  });

  it("recognizes git behind a leading environment-variable assignment", () => {
    const rows = extractGitOpsFor([
      'HUSKY=0 git commit -m "x"',
      "GIT_EDITOR=true git rebase --continue",
    ]);
    expect(rows).toEqual([
      { op: "commit", branch: null, commit_hash: null },
      { op: "rebase", branch: null, commit_hash: null },
    ]);
  });

  it("skips git's own global options to find the subcommand", () => {
    const rows = extractGitOpsFor([
      "git --no-pager diff",
      "git -C /tmp/repo status",
    ]);
    expect(rows).toEqual([
      { op: "diff", branch: null, commit_hash: null },
      { op: "status", branch: null, commit_hash: null },
    ]);
  });

  it("records nothing for commands that only mention git as text, not as the command word", () => {
    const rows = extractGitOpsFor([
      'echo "run git push"',
      'grep -rn "git commit" docs/',
      "cat notes.md | grep git",
    ]);
    expect(rows).toEqual([]);
  });

  it("keeps a quoted && from splitting a single commit invocation", () => {
    const rows = extractGitOpsFor(['git commit -m "a && b"']);
    expect(rows).toEqual([{ op: "commit", branch: null, commit_hash: null }]);
  });

  it("records nothing for an unterminated quote", () => {
    const rows = extractGitOpsFor(['git commit -m "unterminated']);
    expect(rows).toEqual([]);
  });

  it("keeps a backslash-newline line continuation from breaking a compound", () => {
    const cmd = 'git add x && \\\n  git commit -m "y"';
    const rows = extractGitOpsFor([cmd]);
    expect(rows).toEqual([
      { op: "add", branch: null, commit_hash: null },
      { op: "commit", branch: null, commit_hash: null },
    ]);
  });
});
