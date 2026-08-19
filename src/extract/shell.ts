import type { Command } from "unbash";
import type { DatabaseType } from "../db/client.js";
import { redactText } from "../redact/index.js";
import { type ExtractScope, scopeAnd, scopedDelete } from "./scope.js";
import { commandArgv, reachableCommands } from "./shellParse.js";

/**
 * shell_commands: one row per Bash/Shell invocation.
 *
 * cmd_head = the first non-wrapper word of the command as a shell parser reads
 * it. Wrappers like `env`, `time`, `sudo`, `nohup`, `exec`, `command` are
 * stripped so `git`, `npm`, `cargo`, `kubectl` all group cleanly, as are
 * `VAR=value` assignments.
 *
 * The head is derived from a parse, not from a whitespace split, because a
 * split cannot tell a shell metacharacter from an ordinary character inside a
 * quoted word: `IFS=';' read -r a b` and `PGPASSWORD="a;b" psql ...` both got
 * cut at the quoted `;`, leaving only a fragment that looks like an assignment,
 * and landed in the NULL bucket -- silently undercounting `top commands` and,
 * because git.ts filters on `cmd_head = 'git'`, hiding those sessions' git
 * operations too.
 *
 * A command that does not parse has no knowable command word, so its head is
 * NULL rather than a guess. The row itself is still stored: the
 * invocation happened, and `cmd_full` records it whole.
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
      // Stored whole, not truncated. `cmd_head` is the short form; this column
      // is the analyzable one, and downstream extractors parse it as shell. A
      // cap here cut ~17% of commands mid-quote or mid-heredoc, which is
      // indistinguishable from genuinely malformed input to any real parser --
      // so a parser-based extractor lost every operation in those commands
      // rather than just the truncated tail.
      //
      // Redacted on the way in. The source column (`tool_calls.args_json`) is
      // not redacted at normalize time -- only `args_preview` and
      // `output_preview` are -- so a command carrying a token in an env
      // assignment or header would otherwise be stored verbatim, and storing
      // it whole means storing more of it.
      const storedCmd = redactText(cmd).text;
      insert.run(
        row.session_id,
        row.turn,
        row.idx,
        head,
        storedCmd,
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
  // The first command word the parser reaches, over the same bounded scope
  // every other shell-derived fact uses. An unparseable command reaches
  // nothing, so its head is NULL.
  //
  // Commands are tried in order rather than taking only the first, because a
  // statement can carry no command word at all: a script that opens with a
  // bare `WT=/path/to/tree` assignment before running `git -C "$WT" ...` has an
  // assignment-only first command, and the head of that script is `git`.
  for (const command of reachableCommands(cmd)) {
    const head = headOfCommand(command);
    if (head !== null) return head;
  }
  return null;
}

/**
 * The command word of one command, with wrappers stripped, or `null` if it has
 * none (an assignment-only command, or one that is nothing but wrappers).
 */
function headOfCommand(command: Command): string | null {
  // Assignment prefixes are already excluded by the parser, so this walk only
  // has to handle the ones that follow a wrapper (`env FOO=bar git status`).
  for (const tok of commandArgv(command)) {
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
