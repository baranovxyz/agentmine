import type { DatabaseType } from "../db/client.js";
import { type ExtractScope, scopeAnd, scopedDelete } from "./scope.js";

/**
 * files_touched: one row per file operation extracted from tool_calls.
 *
 * Two arg shapes:
 *   - object-args tools (Read/Write/Edit/...): args.file_path is the path,
 *     op is fixed by tool name. See `TOOL_TO_OP`.
 *   - patch-string tools (codex `apply_patch`): args is a raw patch body;
 *     each `*** Add|Update|Delete File: <path>` directive yields one row.
 */
const TOOL_TO_OP: Record<string, string> = {
  Read: "read",
  read: "read",
  read_file: "read",
  Write: "write",
  write: "write",
  write_to_file: "write",
  Edit: "edit",
  edit: "edit",
  StrReplace: "edit",
  strReplace: "edit",
  replace_in_file: "edit",
  MultiEdit: "edit",
  multiEdit: "edit",
  Delete: "delete",
  delete: "delete",
};

/** Tools whose args are a raw patch body, not a JSON object. */
const PATCH_TOOLS = new Set(["apply_patch"]);
const FILE_LIST_TOOLS = new Set(["opencode_patch"]);
const TRACKED_TOOLS = [
  ...Object.keys(TOOL_TO_OP),
  ...PATCH_TOOLS,
  ...FILE_LIST_TOOLS,
];

const PATCH_DIRECTIVE_TO_OP: Record<string, string> = {
  Add: "write",
  Update: "edit",
  Delete: "delete",
};

interface ToolCallRow {
  session_id: string;
  turn: number;
  name: string;
  args_json: string | null;
}

export function extractFilesTouched(
  db: DatabaseType,
  scope: ExtractScope,
): number {
  scopedDelete(db, scope, "files_touched");
  const rows = db
    .prepare<[string[]], ToolCallRow>(
      `SELECT session_id, turn, name, args_json
         FROM tool_calls
        WHERE name IN (${TRACKED_TOOLS.map(() => "?").join(",")})${scopeAnd(scope)}`,
    )
    .all(TRACKED_TOOLS);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO files_touched (session_id, turn, op, path, bytes_changed)
     VALUES (?, ?, ?, ?, ?)`,
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
      const ops: Array<{ op: string; path: string }> = PATCH_TOOLS.has(row.name)
        ? extractPatchOps(args)
        : FILE_LIST_TOOLS.has(row.name)
          ? fileListOps(args)
          : objectOps(row.name, args);
      for (const { op, path } of ops) {
        insert.run(row.session_id, row.turn, op, path, null);
        inserted += 1;
      }
    }
  });
  tx();
  return inserted;
}

function objectOps(
  name: string,
  args: unknown,
): Array<{ op: string; path: string }> {
  const op = TOOL_TO_OP[name];
  if (!op || !args || typeof args !== "object") return [];
  return extractPaths(args).map((path) => ({ op, path }));
}

/**
 * Codex `apply_patch` carries a raw patch body. Each directive line of the
 * form `*** Add|Update|Delete File: <path>` produces one files_touched row.
 * Anything else in the body (hunks, context lines) is ignored.
 */
function extractPatchOps(args: unknown): Array<{ op: string; path: string }> {
  if (typeof args !== "string") return [];
  const out: Array<{ op: string; path: string }> = [];
  const re = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  for (const match of args.matchAll(re)) {
    const op = PATCH_DIRECTIVE_TO_OP[match[1]!];
    const path = match[2]!.trim();
    if (op && path) out.push({ op, path });
  }
  return out;
}

function fileListOps(args: unknown): Array<{ op: string; path: string }> {
  const obj = asRecord(args);
  if (obj === null) return [];
  const files = obj.files;
  if (!Array.isArray(files)) return [];
  return files
    .filter(
      (path): path is string => typeof path === "string" && path.length > 0,
    )
    .map((path) => ({ op: "edit", path }));
}

function extractPaths(args: unknown): string[] {
  const out: string[] = [];
  const obj = asRecord(args);
  if (obj === null) return out;
  for (const key of [
    "file_path",
    "filePath",
    "path",
    "rel_path",
    "target_file",
    "targetFile",
  ]) {
    const v = obj[key];
    if (typeof v === "string" && v) out.push(v);
  }
  // MultiEdit: `edits` array with file-level grouping is uncommon in CC;
  // typical shape has a single file_path. For paths arrays:
  const pathsField = obj.paths;
  if (Array.isArray(pathsField)) {
    for (const p of pathsField) if (typeof p === "string") out.push(p);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}
