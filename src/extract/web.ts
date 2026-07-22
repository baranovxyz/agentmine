import type { DatabaseType } from "../db/client.js";
import { type ExtractScope, scopedDelete, scopeWhere } from "./scope.js";

/**
 * web_fetches: one row per WebFetch / WebSearch / browser_navigate call.
 *
 * The `kind` column is one of `fetch | search | navigate`; the union covers
 * both human-style web research (`WebSearch`) and headless browsing
 * (`browser_navigate`, `WebFetch`).
 */

const FETCH_NAMES = new Set(["WebFetch", "webfetch", "fetch"]);
// `web_search` is what the codex adapter emits for OpenAI Responses API
// `web_search_call` items; args carry { queries: [...] }.
const SEARCH_NAMES = new Set([
  "WebSearch",
  "websearch",
  "search",
  "web_search",
]);
const NAV_NAMES = new Set(["browser_navigate", "Navigate"]);

interface ToolCallRow {
  session_id: string;
  turn: number;
  idx: number;
  name: string;
  args_json: string | null;
}

export function extractWebFetches(
  db: DatabaseType,
  scope: ExtractScope,
): number {
  scopedDelete(db, scope, "web_fetches");

  const rows = db
    .prepare<[], ToolCallRow>(
      `SELECT session_id, turn, idx, name, args_json FROM tool_calls${scopeWhere(scope)}`,
    )
    .all();

  const insert = db.prepare(
    `INSERT OR IGNORE INTO web_fetches
       (session_id, turn, idx, kind, url, domain, query)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const kind = classifyKind(r.name);
      if (!kind) continue;
      if (!r.args_json) continue;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(r.args_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      const url = pickString(args, ["url", "URL", "href"]);
      let query = pickString(args, ["query", "q", "search_term", "searchTerm"]);
      // codex web_search stores `queries: string[]` instead of `query`.
      if (!query) {
        const list = args["queries"];
        if (Array.isArray(list)) {
          const first = list.find((v) => typeof v === "string" && v.trim());
          if (typeof first === "string") query = first.trim();
        }
      }
      const domain = url ? deriveDomain(url) : null;
      if (!url && !query) continue;
      insert.run(r.session_id, r.turn, r.idx, kind, url, domain, query);
      inserted += 1;
    }
  });
  tx();
  return inserted;
}

function classifyKind(name: string): "fetch" | "search" | "navigate" | null {
  if (FETCH_NAMES.has(name)) return "fetch";
  if (SEARCH_NAMES.has(name)) return "search";
  if (NAV_NAMES.has(name)) return "navigate";
  return null;
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function deriveDomain(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname || null;
  } catch {
    return null;
  }
}
