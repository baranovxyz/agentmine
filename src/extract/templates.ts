import { createHash } from "node:crypto";
import type { DatabaseType } from "../db/client.js";
import { isInjectedNoise } from "./noiseFilter.js";

/**
 * prompt_templates: aggregate distinct first-user-prompts by a normalized
 * "shape" — strip paths, ids, numbers, code spans, and extra whitespace —
 * to surface recurring prompt patterns.
 *
 * Keep templates with count >= 3.
 */

const MIN_COUNT = 3;

interface SessionRow {
  id: string;
  first_user_prompt: string | null;
}

export function extractPromptTemplates(db: DatabaseType): number {
  db.prepare(`DELETE FROM prompt_templates`).run();

  const rows = db
    .prepare<[], SessionRow>(
      `SELECT id, first_user_prompt FROM sessions WHERE first_user_prompt IS NOT NULL`,
    )
    .all();

  interface Agg {
    template: string;
    count: number;
    sessionIds: string[];
  }
  const aggMap = new Map<string, Agg>();

  for (const r of rows) {
    if (!r.first_user_prompt) continue;
    // Drop sessions whose "first user prompt" is actually an injected skill
    // body, continuation preamble, or hook echo — those aren't real prompts.
    if (isInjectedNoise(r.first_user_prompt)) continue;
    const template = normalize(r.first_user_prompt);
    if (!template) continue;
    const hash = createHash("sha256")
      .update(template)
      .digest("hex")
      .slice(0, 16);
    let agg = aggMap.get(hash);
    if (!agg) {
      agg = { template, count: 0, sessionIds: [] };
      aggMap.set(hash, agg);
    }
    agg.count += 1;
    if (agg.sessionIds.length < 5) agg.sessionIds.push(r.id);
  }

  const insert = db.prepare(
    `INSERT OR REPLACE INTO prompt_templates (hash, template, count, example_session_ids)
     VALUES (?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const [hash, agg] of aggMap) {
      if (agg.count < MIN_COUNT) continue;
      insert.run(
        hash,
        agg.template.slice(0, 500),
        agg.count,
        JSON.stringify(agg.sessionIds),
      );
      inserted += 1;
    }
  });
  tx();
  return inserted;
}

function normalize(text: string): string {
  let t = text.trim();
  // strip code spans / fences
  t = t.replace(/`[^`]*`/g, "<code>");
  t = t.replace(/```[\s\S]*?```/g, "<code>");
  // strip absolute paths
  t = t.replace(/(?:\/[A-Za-z0-9._-]+)+/g, "<path>");
  // strip numbers
  t = t.replace(/\d+/g, "<n>");
  // strip ids that look like uuids or shaXX
  t = t.replace(/\b[0-9a-f]{8,}\b/gi, "<id>");
  // collapse whitespace
  t = t.replace(/\s+/g, " ").trim().toLowerCase();
  return t;
}
