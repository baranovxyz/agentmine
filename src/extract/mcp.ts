import type { DatabaseType } from "../db/client.js";

/**
 * mcp_calls: one row per MCP tool invocation.
 *
 * Three patterns recognized across the tool ecosystems we ingest:
 *   1. tool name = "CallMcpTool" / "call_mcp_tool"  → args has { server, toolName }
 *   2. tool name = "mcp__<server>__<tool>"          (Claude Code legacy)
 *   3. tool name = "mcp_<server>_<tool>"            (Cursor flat naming)
 */

interface ToolCallRow {
  session_id: string;
  turn: number;
  idx: number;
  name: string;
  args_json: string | null;
  args_hash: string | null;
  duration_ms: number | null;
  exit_code: number | null;
}

export function extractMcpCalls(db: DatabaseType): number {
  db.prepare(`DELETE FROM mcp_calls`).run();

  const rows = db
    .prepare<[], ToolCallRow>(
      `SELECT session_id, turn, idx, name, args_json, args_hash, duration_ms, exit_code
         FROM tool_calls`,
    )
    .all();

  const insert = db.prepare(
    `INSERT OR IGNORE INTO mcp_calls
       (session_id, turn, idx, server, tool, args_hash, duration_ms, exit_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const parsed = parseMcpInvocation(r.name, r.args_json);
      if (!parsed) continue;
      insert.run(
        r.session_id,
        r.turn,
        r.idx,
        parsed.server,
        parsed.tool,
        r.args_hash,
        r.duration_ms,
        r.exit_code,
      );
      inserted += 1;
    }
  });
  tx();
  return inserted;
}

interface McpInvocation {
  server: string;
  tool: string;
}

function parseMcpInvocation(
  name: string,
  argsJson: string | null,
): McpInvocation | null {
  if (
    /^(call_)?mcp_tool$/i.test(name) ||
    name === "CallMcpTool" ||
    name === "use_mcp_tool"
  ) {
    if (!argsJson) return null;
    try {
      const obj = asRecord(JSON.parse(argsJson));
      if (obj === null) return null;
      const server = pickString(obj, ["server", "serverName", "server_name"]);
      const tool = pickString(obj, ["toolName", "tool_name", "tool", "name"]);
      if (server && tool) return { server, tool };
    } catch {
      /* fallthrough */
    }
    return null;
  }
  // mcp__<server>__<tool>
  const dd = name.match(/^mcp__([a-zA-Z0-9._-]+)__(.+)$/);
  if (dd) return { server: dd[1]!, tool: dd[2]! };

  // mcp_<server>_<tool>  (single underscore; rare and ambiguous, only used
  // when the prefix is unmistakable)
  const single = name.match(/^mcp_([a-zA-Z0-9.-]+)_(.+)$/);
  if (single) return { server: single[1]!, tool: single[2]! };

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
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
