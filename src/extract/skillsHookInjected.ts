import type { DatabaseType } from "../db/client.js";
import { slugFromSkillDirectory } from "./parseSkillListing.js";

const HOOK_PREAMBLE = /^Base directory for this skill:\s*(\S+)/m;

/**
 * skills_hook_injected: skill bodies Claude Code injected via hooks
 * (full SKILL.md echoed as a user turn). These count as "used" even when
 * no explicit Skill tool call landed in tool_calls.
 */
export function extractSkillsHookInjected(db: DatabaseType): number {
  db.prepare(`DELETE FROM skills_hook_injected`).run();

  const rows = db
    .prepare<[], { session_id: string; turn: number; text: string }>(
      `SELECT session_id, turn, text
         FROM messages
        WHERE role = 'user'
          AND text LIKE 'Base directory for this skill:%'`,
    )
    .all();

  const insert = db.prepare(
    `INSERT OR IGNORE INTO skills_hook_injected
       (session_id, turn, skill_slug, source_path)
     VALUES (?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const m = row.text.match(HOOK_PREAMBLE);
      if (!m?.[1]) continue;
      const sourcePath = m[1]!;
      const slug = slugFromSkillDirectory(sourcePath);
      if (!slug) continue;
      insert.run(row.session_id, row.turn, slug, sourcePath);
      inserted += 1;
    }
  });
  tx();
  return inserted;
}
