import type { DatabaseType } from "../db/client.js";
import { type ExtractScope, scopedDelete, scopeWhere } from "./scope.js";

/**
 * skills_invoked: one row per agent skill invocation.
 *
 * Sources we recognize:
 *   - tool_calls.name = 'Skill' / 'skill'  → args.skill_id (or .name) is the skill slug
 *   - args containing `SKILL.md` path      → derive slug from the path segment
 *   - tool_calls.name starting with "skill_<slug>"  (Cursor / opencode variants)
 */

interface ToolCallRow {
  session_id: string;
  turn: number;
  idx: number;
  name: string;
  args_json: string | null;
}

export function extractSkillsInvoked(
  db: DatabaseType,
  scope: ExtractScope,
): number {
  scopedDelete(db, scope, "skills_invoked");

  const rows = db
    .prepare<[], ToolCallRow>(
      `SELECT session_id, turn, idx, name, args_json FROM tool_calls${scopeWhere(scope)}`,
    )
    .all();

  const insert = db.prepare(
    `INSERT OR IGNORE INTO skills_invoked (session_id, turn, idx, skill_name) VALUES (?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const slugs = collectSkillSlugs(r.name, r.args_json);
      let i = r.idx;
      for (const slug of slugs) {
        insert.run(r.session_id, r.turn, i, slug);
        inserted += 1;
        i += 1;
      }
    }
  });
  tx();
  return inserted;
}

function collectSkillSlugs(name: string, argsJson: string | null): string[] {
  const out: string[] = [];

  // tool name like "skill_create-rule" or "Skill"
  if (/^skill$/i.test(name)) {
    if (argsJson) {
      const slug = slugFromArgs(argsJson);
      if (slug) out.push(slug);
    }
    return dedupe(out);
  }
  const skillTool = name.match(/^skill[_:-](.+)$/i);
  if (skillTool && skillTool[1]) {
    out.push(skillTool[1]);
    return dedupe(out);
  }

  // Sometimes a Skill is invoked indirectly by passing a SKILL.md path to Read.
  // We only record this when the args explicitly reference SKILL.md, since
  // many other Read calls touch arbitrary files.
  if (argsJson && argsJson.includes("SKILL.md")) {
    const slug = slugFromSkillPath(argsJson);
    if (slug) out.push(slug);
  }
  return dedupe(out);
}

function slugFromArgs(argsJson: string): string | null {
  try {
    const obj = JSON.parse(argsJson) as Record<string, unknown>;
    for (const k of ["skill_id", "skillId", "skill", "name", "slug", "id"]) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    const path = obj["path"] ?? obj["file_path"];
    if (typeof path === "string") return slugFromSkillPath(path);
  } catch {
    /* ignore */
  }
  return null;
}

function slugFromSkillPath(s: string): string | null {
  // .../skills/<slug>/SKILL.md  or  .../skills-<scope>/<slug>/SKILL.md
  const m = s.match(/skills(?:-[a-z]+)?\/([^/]+)\/SKILL\.md/);
  return m && m[1] ? m[1] : null;
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
