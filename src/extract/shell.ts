import type { DatabaseType } from "../db/client.js";
import { type ExtractScope, scopeAnd, scopedDelete } from "./scope.js";

/**
 * shell_commands: one row per Bash/Shell invocation.
 *
 * cmd_head = first non-wrapper token. Wrappers like `env`, `time`, `sudo`,
 * `nohup`, `exec`, `command` are stripped so `git`, `npm`, `cargo`, `kubectl`
 * all group cleanly. Also strips leading `VAR=value` assignments.
 */
const SHELL_TOOL_NAMES = [
  "Bash",
  "bash",
  "Shell",
  "shell",
  "exec_command",
  "execute_command",
] as const;
const WRAPPERS = new Set([
  "env",
  "time",
  "sudo",
  "nohup",
  "exec",
  "command",
  "timeout",
  "nice",
  "xargs",
]);

interface ToolCallRow {
  session_id: string;
  turn: number;
  idx: number;
  args_json: string | null;
  exit_code: number | null;
  duration_ms: number | null;
}

export function extractShellCommands(
  db: DatabaseType,
  scope: ExtractScope,
): number {
  scopedDelete(db, scope, "shell_commands");
  const rows = db
    .prepare<[string[]], ToolCallRow>(
      `SELECT session_id, turn, idx, args_json, exit_code, duration_ms
         FROM tool_calls
        WHERE name IN (${SHELL_TOOL_NAMES.map(() => "?").join(",")})${scopeAnd(scope)}`,
    )
    .all(SHELL_TOOL_NAMES as unknown as string[]);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO shell_commands
       (session_id, turn, idx, cmd_head, cmd_full, exit_code, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (!row.args_json) continue;
      let args: unknown;
      try {
        args = JSON.parse(row.args_json);
      } catch {
        continue;
      }
      const cmd = extractCommand(args);
      if (!cmd) continue;
      const head = parseHead(cmd);
      insert.run(
        row.session_id,
        row.turn,
        row.idx,
        head,
        cmd.slice(0, 500),
        row.exit_code,
        row.duration_ms,
      );
      inserted += 1;
    }
  });
  tx();
  return inserted;
}

function extractCommand(args: unknown): string | null {
  const obj = asRecord(args);
  if (obj === null) return null;
  for (const key of ["command", "cmd", "shell_command", "shellCommand"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function parseHead(cmd: string): string | null {
  const tokens = tokenize(cmd);
  for (const tok of tokens) {
    // skip VAR=value
    if (/^[A-Z_][A-Z0-9_]*=.*/.test(tok)) continue;
    // skip wrappers
    if (WRAPPERS.has(tok)) continue;
    // skip leading redirect/flags
    if (tok.startsWith("-")) continue;
    // basename of path-like commands (e.g. /usr/bin/git -> git)
    const last = tok.split("/").pop();
    return last ?? tok;
  }
  return null;
}

function tokenize(cmd: string): string[] {
  // Very light tokenizer: split on whitespace, stop at first shell operator.
  const cut = cmd.split(/[|&;<>(]/)[0] ?? cmd;
  return cut.split(/\s+/).filter(Boolean);
}
