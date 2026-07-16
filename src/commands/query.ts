import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";

export const queryCommand = defineCommand({
  meta: {
    name: "query",
    description: "Run an ad-hoc SELECT query against sessions.db (read-only)",
  },
  args: {
    sql: { type: "positional", description: "SELECT ...", required: true },
    limit: {
      type: "string",
      default: "500",
      description: "Safety cap on rows",
    },
  },
  async run({ args }) {
    await runCommand({
      command: "agentmine query",
      handler: async () => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine sync` + `agentmine normalize` + `agentmine extract`.",
          );
        }
        const sql = String(args.sql ?? "").trim();
        if (!sql) throw Errors.invalidInput("Empty SQL");
        if (!isSelectLike(sql)) {
          throw Errors.invalidInput(
            "Only read-only SELECT / WITH / EXPLAIN queries allowed. Opens in readonly mode.",
          );
        }
        const limit = toLimit(args.limit, 500);

        const db = openDb({ readonly: true });
        try {
          const stmt = db.prepare(sql);
          const rows = stmt.all() as unknown[];
          const capped = rows.length > limit;
          return {
            data: {
              row_count: rows.length,
              truncated: capped,
              limit,
              rows: capped ? rows.slice(0, limit) : rows,
            },
          };
        } catch (e) {
          throw Errors.invalidInput(`SQL error: ${(e as Error).message}`);
        } finally {
          db.close();
        }
      },
    });
  },
});

function isSelectLike(sql: string): boolean {
  const t = sql.trim().toLowerCase();
  return (
    t.startsWith("select ") ||
    t.startsWith("select\n") ||
    t.startsWith("with ") ||
    t.startsWith("explain ")
  );
}

function toLimit(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 10000) return fallback;
  return n;
}
