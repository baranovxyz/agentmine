import type { DatabaseType } from "../db/client.js";
import { parseSkillListingContent } from "./parseSkillListing.js";

interface RawEventRow {
  session_id: string;
  seq: number;
  raw_json: string;
}

const SKILL_LISTING_MARKER =
  "The following skills are available for use with the Skill tool";

/**
 * skills_available: one row per (session, skill) loaded into context.
 *
 * Sources (claude-code only):
 *   - raw_events attachment.type = skill_listing (primary since CC ~2.1)
 *   - user raw lines with SessionStart system-reminder skill catalogs
 *
 * Union semantics: if a skill appears in multiple listings mid-session,
 * keep the latest description (last source_seq wins on INSERT OR REPLACE).
 */
export function extractSkillsAvailable(db: DatabaseType): number {
  db.prepare(`DELETE FROM skills_available`).run();

  const ccSessions = new Set(
    db
      .prepare<[], { id: string }>(
        `SELECT id FROM sessions WHERE source = 'claude-code'`,
      )
      .all()
      .map((r) => r.id),
  );
  if (ccSessions.size === 0) return 0;

  const rows = db
    .prepare<[string], RawEventRow>(
      `SELECT session_id, seq, raw_json
         FROM raw_events
        WHERE CASE
                WHEN json_valid(raw_json)
                THEN json_extract(raw_json, '$.attachment.type')
              END = 'skill_listing'
           OR raw_json LIKE '%' || ? || '%'
        ORDER BY session_id, seq`,
    )
    .all(SKILL_LISTING_MARKER);

  const insert = db.prepare(
    `INSERT INTO skills_available
       (session_id, skill_name, description, origin, source_seq, is_initial)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, skill_name) DO UPDATE SET
       description = excluded.description,
       origin = excluded.origin,
       source_seq = excluded.source_seq,
       is_initial = excluded.is_initial`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (!ccSessions.has(row.session_id)) continue;
      const listings = extractListingsFromRaw(row.raw_json);
      for (const listing of listings) {
        for (const skill of listing.skills) {
          insert.run(
            row.session_id,
            skill.skillName,
            skill.description,
            skill.origin,
            row.seq,
            listing.isInitial ? 1 : 0,
          );
          inserted += 1;
        }
      }
    }
  });
  tx();
  return inserted;
}

function extractListingsFromRaw(rawJson: string): Array<{
  skills: ReturnType<typeof parseSkillListingContent>;
  isInitial: boolean;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  const obj = asRecord(parsed);
  if (obj === null) return [];

  const out: Array<{
    skills: ReturnType<typeof parseSkillListingContent>;
    isInitial: boolean;
  }> = [];

  const attachment = asRecord(obj.attachment);
  const attachmentContent = pickString(attachment, "content");
  if (pickString(attachment, "type") === "skill_listing" && attachmentContent) {
    out.push({
      skills: parseSkillListingContent(attachmentContent),
      isInitial: attachment?.isInitial === true,
    });
    return out;
  }

  const text = extractUserText(obj);
  if (text.includes(SKILL_LISTING_MARKER)) {
    out.push({
      skills: parseSkillListingContent(text),
      isInitial: true,
    });
  }
  return out;
}

function extractUserText(obj: Record<string, unknown>): string {
  const message = asRecord(obj.message);
  if (obj.type !== "user" && message?.role !== "user") return "";
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const partRecord = asRecord(part);
      const text = pickString(partRecord, "text");
      return pickString(partRecord, "type") === "text" && text ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function pickString(
  obj: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = obj?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
