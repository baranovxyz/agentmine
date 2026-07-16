import type { DatabaseType } from "../db/client.js";

/**
 * Post-extract pass: populate ended_with_commit and ended_with_commit_attempted.
 *
 * Looks at the latest shell command containing 'git commit' in each session:
 *   CC / opencode: exit_code = 0  → ended_with_commit = 1
 *   Cursor:        no exit codes  → ended_with_commit_attempted = 1 (ended_with_commit stays 0)
 *
 * Must run after extractShellCommands.
 */
export function extractCommitStatus(db: DatabaseType): number {
  // Reset both flags before repopulating.
  db.prepare(
    `UPDATE sessions SET ended_with_commit = 0, ended_with_commit_attempted = 0`,
  ).run();

  interface SessionRow {
    id: string;
    source: string;
  }
  interface CommitRow {
    exit_code: number | null;
  }

  const sessions = db
    .prepare<[], SessionRow>(`SELECT id, source FROM sessions`)
    .all();

  const latestCommit = db.prepare<[string], CommitRow>(
    `SELECT exit_code FROM shell_commands
      WHERE session_id = ? AND cmd_full LIKE '%git commit%'
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
