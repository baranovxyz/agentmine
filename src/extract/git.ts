import type { DatabaseType } from "../db/client.js";
import { type ExtractScope, scopeAnd, scopedDelete } from "./scope.js";
import { commandArgv, reachableCommands } from "./shellParse.js";

/**
 * git_operations: derived from `shell_commands` where `cmd_head = 'git'`.
 *
 * `git_operations` is a fact table people query. A missing row is better
 * than a wrong row: rather than guess at command boundaries with regexes
 * (which fabricate rows for things like a `git push` mentioned inside a
 * commit message, or inside a heredoc body), the full `cmd_full` text is
 * parsed with `unbash`, a real POSIX-ish shell parser. Only a top-level
 * `Command` node (a bare command, or one joined by `&&`/`||`/`;`/`|`) whose
 * resolved command word is literally `git` counts as an invocation -- text
 * that merely contains the word "git" inside a string, a heredoc body, or
 * another command's argument never does. If the parser reports any syntax
 * error (e.g. an unterminated quote) for the command, or throws, the whole
 * command is treated as unparseable and yields no rows at all.
 *
 * Subcommand is the first non-flag argument after skipping git's own global
 * options (`--no-pager`, `-C <path>`, `-c <k=v>`, `--git-dir=...`,
 * `--work-tree=...`, `--exec-path=...`, `-P`). Branch name (for
 * checkout/branch/switch) and commit hash (for show/log/cherry-pick)
 * extracted heuristically from the remaining arguments.
 *
 * Must run AFTER shell.ts in the orchestrator.
 */

const KNOWN_OPS = new Set([
  "add",
  "branch",
  "checkout",
  "cherry-pick",
  "clone",
  "commit",
  "diff",
  "fetch",
  "log",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "show",
  "stash",
  "status",
  "switch",
  "tag",
  "worktree",
]);

/** git's own leading global options, skipped before looking for the subcommand. */
const GLOBAL_FLAGS_NO_ARG = new Set(["--no-pager", "-P"]);
const GLOBAL_FLAGS_WITH_ARG = new Set(["-C", "-c"]);
const GLOBAL_FLAGS_ATTACHED_PREFIXES = [
  "--git-dir=",
  "--work-tree=",
  "--exec-path=",
];

interface ShellRow {
  session_id: string;
  turn: number;
  idx: number;
  cmd_full: string | null;
  exit_code: number | null;
}

export function extractGitOperations(
  db: DatabaseType,
  scope: ExtractScope,
): number {
  scopedDelete(db, scope, "git_operations");

  const rows = db
    .prepare<[], ShellRow>(
      // Ordered explicitly: `idx` below is assigned in iteration order, so a
      // reader ordering git_operations by (turn, idx) gets source order --
      // which commit.ts relies on to find a session's LAST commit.
      `SELECT session_id, turn, idx, cmd_full, exit_code FROM shell_commands WHERE cmd_head = 'git'${scopeAnd(scope)}
        ORDER BY session_id, turn, idx`,
    )
    .all();

  const insert = db.prepare(
    `INSERT OR IGNORE INTO git_operations
       (session_id, turn, idx, op, branch, commit_hash, exit_code, cmd_full)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  // Track per-(session_id, turn) insertion index to avoid PK collisions when
  // one shell command expands to multiple git ops (e.g. "git add . && git commit").
  const opIdx = new Map<string, number>();

  const tx = db.transaction(() => {
    for (const r of rows) {
      const cmd = r.cmd_full ?? "";
      if (!cmd) continue;
      const invocations = parseGitInvocations(cmd);
      for (const parsed of invocations) {
        const key = `${r.session_id}:${r.turn}`;
        const idx = opIdx.get(key) ?? 0;
        opIdx.set(key, idx + 1);
        insert.run(
          r.session_id,
          r.turn,
          idx,
          parsed.op,
          parsed.branch,
          parsed.commitHash,
          r.exit_code,
          // Denormalized whole, matching `shell_commands.cmd_full`. `idx` here
          // is a per-turn operation counter, not the shell command's index, so
          // a reader cannot join back to recover the text.
          cmd,
        );
        inserted += 1;
      }
    }
  });
  tx();
  return inserted;
}

interface ParsedGit {
  op: string;
  branch: string | null;
  commitHash: string | null;
}

/**
 * Return one entry per real `git` invocation the parser reaches: a bare
 * command, or one joined to others by `&&`, `||`, `;`, or `|`. Text inside a
 * heredoc body, inside another command's quoted argument, or inside a nested
 * `$( ... )` never produces an entry -- those are either not parsed as a
 * command at all, or (deliberately) not walked into. See `shellParse.ts` for
 * the shared scope and refusal rules.
 */
function parseGitInvocations(cmd: string): ParsedGit[] {
  const results: ParsedGit[] = [];
  for (const command of reachableCommands(cmd)) {
    if (command.name?.value !== "git") continue;
    // `commandArgv` leads with the command word; git's own argv is what follows.
    const op = parseGitCommand(commandArgv(command).slice(1));
    if (op) results.push(op);
  }
  return results;
}

/** `suffix` is git's own argv, already dequoted and tokenized by unbash. */
function parseGitCommand(suffix: string[]): ParsedGit | null {
  let i = 0;
  while (i < suffix.length) {
    const t = suffix[i]!;
    if (GLOBAL_FLAGS_NO_ARG.has(t)) {
      i += 1;
      continue;
    }
    if (GLOBAL_FLAGS_WITH_ARG.has(t)) {
      i += 2; // flag + its separate argument
      continue;
    }
    if (GLOBAL_FLAGS_ATTACHED_PREFIXES.some((prefix) => t.startsWith(prefix))) {
      i += 1;
      continue;
    }
    break;
  }

  let op: string | null = null;
  let opIndex = -1;
  for (let j = i; j < suffix.length; j += 1) {
    const t = suffix[j]!;
    if (t.startsWith("-")) continue;
    op = t;
    opIndex = j;
    break;
  }
  if (op === null) return null;
  // Normalize a few synonyms.
  if (op === "co") op = "checkout";
  if (op === "ci") op = "commit";
  if (op === "br") op = "branch";
  if (!KNOWN_OPS.has(op)) return null;

  let branch: string | null = null;
  let commitHash: string | null = null;

  if (op === "checkout" || op === "switch" || op === "branch") {
    for (let j = opIndex + 1; j < suffix.length; j += 1) {
      const t = suffix[j]!;
      if (t.startsWith("-")) continue;
      branch = t;
      break;
    }
  }
  if (op === "show" || op === "cherry-pick" || op === "log") {
    for (const t of suffix) {
      if (/^[0-9a-f]{7,40}$/i.test(t)) {
        commitHash = t.toLowerCase();
        break;
      }
    }
  }

  return { op, branch, commitHash };
}
