import type { DatabaseType } from "../db/client.js";
import { type ExtractScope, scopeWhere } from "./scope.js";

/**
 * Post-extract pass: populate ended_with_commit and ended_with_commit_attempted.
 *
 * Looks at each session's latest real `git commit` invocation:
 *   CC / opencode: exit_code = 0  → ended_with_commit = 1
 *   Cursor:        no exit codes  → ended_with_commit_attempted = 1 (ended_with_commit stays 0)
 *
 * The invocation comes from `git_operations`, which is parse-derived, not from
 * matching `cmd_full LIKE '%git commit%'`. The text match
 * counted any command that merely CONTAINED that phrase, so a later
 * `grep -rn "git commit" docs/` -- or a commit message quoting the phrase --
 * became "the latest commit" and overwrote a real successful commit with an
 * unrelated command's exit code, flipping the session's flag to 0.
 *
 * Must run after extractGitOperations (which must itself run after
 * extractShellCommands).
 */
export function extractCommitStatus(
  db: DatabaseType,
  scope: ExtractScope,
): number {
  // Reset both flags before repopulating (in-scope sessions only).
  db.prepare(
    `UPDATE sessions SET ended_with_commit = 0, ended_with_commit_attempted = 0${scopeWhere(scope, "id")}`,
  ).run();

  interface SessionRow {
    id: string;
    source: string;
  }
  interface CommitRow {
    exit_code: number | null;
  }

  const sessions = db
    .prepare<[], SessionRow>(
      `SELECT id, source FROM sessions${scopeWhere(scope, "id")}`,
    )
    .all();

  const latestCommit = db.prepare<[string], CommitRow>(
    `SELECT exit_code FROM git_operations
      WHERE session_id = ? AND op = 'commit'
      ORDER BY turn DESC, idx DESC LIMIT 1`,
  );

  let updated = 0;
  const tx = db.transaction(() => {
    for (const s of sessions) {
      const row = latestCommit.get(s.id);
      if (!row) continue;

      if (s.source === "cursor") {
        db.prepare(
          `UPDATE sessions SET ended_with_commit_attempted = 1 WHERE id = ?`,
        ).run(s.id);
      } else if (row.exit_code === 0) {
        db.prepare(
          `UPDATE sessions SET ended_with_commit = 1 WHERE id = ?`,
        ).run(s.id);
      }
      updated += 1;
    }
  });
  tx();
  return updated;
}
