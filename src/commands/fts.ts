import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
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
          const params: unknown[] = args.role
            ? [q, String(args.role), limit]
            : [q, limit];
          const sql = `
            SELECT f.session_id, f.turn, m.role, s.project_path,
                   snippet(messages_fts, 2, '[', ']', '...', 16) AS snippet
              FROM messages_fts f
              JOIN messages m ON m.session_id = f.session_id AND m.turn = f.turn
              JOIN sessions s ON s.id = f.session_id
             WHERE messages_fts MATCH ?
               ${extraJoin}
             ORDER BY rank LIMIT ?`;
          let rows: unknown[];
          try {
            rows = db.prepare(sql).all(...params) as unknown[];
          } catch (e) {
            throw Errors.invalidInput(
              `FTS5 query error: ${(e as Error).message}. Tip: wrap phrases with hyphens in double quotes, e.g. '"agent-first"'. See https://sqlite.org/fts5.html`,
            );
          }
          return { data: { query: q, row_count: rows.length, rows } };
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
