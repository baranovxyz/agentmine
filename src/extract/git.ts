import type { DatabaseType } from "../db/client.js";

/**
 * git_operations: derived from `shell_commands` where `cmd_head = 'git'`.
 *
 * Subcommand parsed by tokenizing the full command and finding the first
 * non-flag token after `git`. Branch name (for checkout/branch/switch) and
 * commit hash (for show/log/cherry-pick) extracted heuristically.
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

interface ShellRow {
  session_id: string;
  turn: number;
  idx: number;
  cmd_full: string | null;
  exit_code: number | null;
}

export function extractGitOperations(db: DatabaseType): number {
  db.prepare(`DELETE FROM git_operations`).run();

  const rows = db
    .prepare<[], ShellRow>(
      `SELECT session_id, turn, idx, cmd_full, exit_code FROM shell_commands WHERE cmd_head = 'git'`,
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
      const segments = splitCompound(cmd);
      for (const seg of segments) {
        const parsed = parseGitSegment(seg);
        if (!parsed) continue;
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
          cmd.slice(0, 500),
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

/** Split a shell command on compound operators so each git sub-command is parsed separately. */
function splitCompound(cmd: string): string[] {
  return cmd.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
}

function parseGitSegment(cmd: string): ParsedGit | null {
  // Strip any remaining shell special chars (subshells, redirects) from a single segment.
  const cut = cmd.split(/[|&;<>(]/)[0] ?? cmd;
  const tokens = cut.split(/\s+/).filter(Boolean);
  // skip leading wrappers
  while (tokens.length && tokens[0] !== "git") tokens.shift();
  if (tokens.shift() !== "git") return null;

  let op: string | null = null;
  for (const t of tokens) {
    if (t.startsWith("-")) continue;
    op = t;
    break;
  }
  if (!op) return null;
  // Normalize a few synonyms.
  if (op === "co") op = "checkout";
  if (op === "ci") op = "commit";
  if (op === "br") op = "branch";
  if (!KNOWN_OPS.has(op)) return null;

  let branch: string | null = null;
  let commitHash: string | null = null;

  if (op === "checkout" || op === "switch" || op === "branch") {
    for (let i = tokens.indexOf(op) + 1; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (!t || t.startsWith("-")) continue;
      branch = t;
      break;
    }
  }
  if (op === "show" || op === "cherry-pick" || op === "log") {
    for (const t of tokens) {
      if (/^[0-9a-f]{7,40}$/i.test(t)) {
        commitHash = t.toLowerCase();
        break;
      }
    }
  }

  return { op, branch, commitHash };
}
