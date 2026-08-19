import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import type { CliWarning } from "../contract/result.js";
import { runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";

export const ftsCommand = defineCommand({
  meta: {
    name: "fts",
    description: "Full-text search over normalized messages (FTS5)",
  },
  args: {
    q: { type: "positional", description: "FTS5 query", required: true },
    limit: { type: "string", default: "20" },
    role: {
      type: "string",
      description: "Restrict to role (user|assistant|...)",
    },
  },
  async run({ args }) {
    await runCommand({
      command: "agentmine fts",
      handler: async () => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine normalize` first.",
          );
        }
        const q = String(args.q ?? "").trim();
        if (!q) throw Errors.invalidInput("Empty query");
        const limit = toLimit(args.limit, 20);

        const db = openDb({ readonly: true });
        try {
          const extraJoin = args.role ? `AND m.role = ?` : "";
          const sql = `
            SELECT f.session_id, f.turn, m.role, s.project_path,
                   snippet(messages_fts, 2, '[', ']', '...', 16) AS snippet
              FROM messages_fts f
              JOIN messages m ON m.session_id = f.session_id AND m.turn = f.turn
              JOIN sessions s ON s.id = f.session_id
             WHERE messages_fts MATCH ?
               ${extraJoin}
             ORDER BY rank LIMIT ?`;
          const buildParams = (matchQuery: string): unknown[] =>
            args.role
              ? [matchQuery, String(args.role), limit]
              : [matchQuery, limit];
          const stmt = db.prepare(sql);

          let rows: unknown[];
          let matched = q;
          let warnings: CliWarning[] | undefined;
          try {
            rows = stmt.all(...buildParams(q)) as unknown[];
          } catch (e) {
            const original = Errors.invalidInput(
              `FTS5 query error: ${(e as Error).message}. Tip: wrap phrases with hyphens in double quotes, e.g. '"agent-first"'. See https://sqlite.org/fts5.html`,
            );
            const sanitized = sanitizeFtsQuery(q);
            if (sanitized === q) throw original;
            try {
              rows = stmt.all(...buildParams(sanitized)) as unknown[];
            } catch {
              throw original;
            }
            matched = sanitized;
            warnings = [
              {
                name: "QUERY_SANITIZED",
                message: `FTS5 rejected the raw query; retried as ${sanitized}. Quote phrases yourself to control matching.`,
              },
            ];
          }

          return {
            data: {
              query: matched,
              ...(matched !== q ? { raw_query: q } : {}),
              row_count: rows.length,
              rows,
            },
            ...(warnings ? { warnings } : {}),
          };
        } finally {
          db.close();
        }
      },
    });
  },
});

function toLimit(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 500) return fallback;
  return n;
}

// --- FTS5 query sanitizer --------------------------------------------------
//
// FTS5's bareword grammar treats `-`, `.`, and other punctuation inside an
// unquoted token as query syntax (most visibly: `no-show` parses as a column
// filter `no` MATCH-ing column `show`, which doesn't exist). Natural-language
// phrases agents type ("no-show", "agent-first") trip this constantly. The
// sanitizer below re-tokenizes the raw string and wraps any bareword that
// isn't safely alphanumeric in double quotes, leaving already-quoted spans,
// parentheses, and the four FTS5 boolean operators (AND/OR/NOT/NEAR, exact
// uppercase) untouched.

type FtsToken =
  | { kind: "quoted"; text: string }
  | { kind: "paren"; text: "(" | ")" }
  | { kind: "operator"; text: string }
  | { kind: "word"; text: string };

const FTS_OPERATORS: ReadonlySet<string> = new Set([
  "AND",
  "OR",
  "NOT",
  "NEAR",
]);

// A bareword is safe to leave unquoted only if it's plain identifier
// characters, with at most one trailing `*` for FTS5 prefix search.
const SAFE_BAREWORD = /^[A-Za-z0-9_]+\*?$/;

function isFtsWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** Reads a `"..."` span starting at `start` (which must be a `"`), treating `""` as an escaped inner quote. Returns the span verbatim, quotes included. */
function readQuotedSpan(
  q: string,
  start: number,
): { span: string; next: number } {
  let span = '"';
  let j = start + 1;
  const n = q.length;
  while (j < n) {
    if (q[j] === '"') {
      if (q[j + 1] === '"') {
        span += '""';
        j += 2;
        continue;
      }
      span += '"';
      j++;
      break;
    }
    span += q[j];
    j++;
  }
  return { span, next: j };
}

function readBareword(
  q: string,
  start: number,
): { word: string; next: number } {
  let j = start;
  const n = q.length;
  while (
    j < n &&
    !isFtsWhitespace(q[j]) &&
    q[j] !== "(" &&
    q[j] !== ")" &&
    q[j] !== '"'
  ) {
    j++;
  }
  return { word: q.slice(start, j), next: j };
}

function tokenizeFtsQuery(q: string): FtsToken[] {
  const tokens: FtsToken[] = [];
  let i = 0;
  const n = q.length;
  while (i < n) {
    const ch = q[i];
    if (isFtsWhitespace(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      const { span, next } = readQuotedSpan(q, i);
      tokens.push({ kind: "quoted", text: span });
      i = next;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ kind: "paren", text: ch });
      i++;
      continue;
    }
    const { word, next } = readBareword(q, i);
    tokens.push(
      FTS_OPERATORS.has(word)
        ? { kind: "operator", text: word }
        : { kind: "word", text: word },
    );
    i = next;
  }
  return tokens;
}

/** Quotes a bareword unless it's already safe, keeping a trailing `*` outside the quotes so prefix search survives. */
function sanitizeWord(word: string): string {
  if (SAFE_BAREWORD.test(word)) return word;
  const hasTrailingStar = word.endsWith("*");
  const inner = hasTrailingStar ? word.slice(0, -1) : word;
  const quoted = `"${inner.replace(/"/g, '""')}"`;
  return hasTrailingStar ? `${quoted}*` : quoted;
}

function joinFtsTokens(tokens: FtsToken[]): string {
  let result = "";
  for (const tok of tokens) {
    const text = tok.kind === "word" ? sanitizeWord(tok.text) : tok.text;
    if (result === "") {
      result = text;
    } else if (text === ")" || result.endsWith("(")) {
      result += text;
    } else {
      result += ` ${text}`;
    }
  }
  return result;
}

/**
 * Rewrites an FTS5 query so every bareword that isn't safely alphanumeric
 * (optionally with a trailing `*`) gets wrapped in double quotes. Quoted
 * spans, parentheses, and exact-uppercase AND/OR/NOT/NEAR operators pass
 * through unchanged. Returns the original string if sanitizing would
 * produce an empty query.
 */
export function sanitizeFtsQuery(q: string): string {
  const tokens = tokenizeFtsQuery(q);
  if (tokens.length === 0) return q;
  const sanitized = joinFtsTokens(tokens);
  return sanitized === "" ? q : sanitized;
}
