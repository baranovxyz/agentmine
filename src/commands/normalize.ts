import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { defineCommand } from "citty";
import {
  listGooseSessionIds,
  listKiloSessionIds,
  listOpencodeSessionIds,
  parseClaudeCodeFile,
  parseClineFile,
  parseCodexFile,
  parseCopilotFile,
  parseCursorFile,
  parseGeminiFile,
  parseGooseSessionFromDb,
  parseKiloSessionFromDb,
  parseOpencodeSession,
  parseOpencodeSessionFromDb,
  parseQwenFile,
} from "../adapters/canonical.js";
import type { RedactionRule } from "../adapters/extension-types.js";
import type { CanonicalSession } from "../adapters/types.js";
import { ingestWorkflowRuns } from "../adapters/workflowRaw.js";
import { getDbPath, paths } from "../config.js";
import { Errors } from "../contract/errors.js";
import {
  reportProgress,
  reportProgressImmediate,
} from "../contract/progress.js";
import { runCommand } from "../contract/result.js";
import {
  CODEX_LINEAGE_BACKFILL_META_KEY,
  dbExists,
  getMeta,
  openDb,
  upsertMeta,
} from "../db/client.js";
import { withWriteLock } from "../db/lock.js";
import { Database } from "../db/sqlite.js";
import { sessionIsUpToDate, upsertSession } from "../db/writer.js";
import { loadExtensions } from "../extensions.js";
import {
  getProjectPathAllowFromEnv,
  projectPathMatchesAllow,
} from "../projectPathFilter.js";
import { redactSession } from "../redact/index.js";
import { parseSince } from "./_filters.js";

/**
 * `agentmine normalize` -- multi-source dispatcher.
 *
 * For each enabled source:
 *   1. Enumerate raw files under `paths.raw<Source>` (the `sync` target).
 *   2. Hand each file to the source's adapter.
 *   3. Apply redaction (unless `--no-redact`).
 *   4. Upsert into SQLite (unless `--dry-run`).
 *
 * `--source` filters to one. Unknown sources are rejected up front.
 */

interface SourceConfig {
  name: string;
  rootPath: string;
  inputMode?: "synced-files" | "live-database";
  listFiles(root: string): Promise<string[]>;
  freshnessSiblings?(filePath: string): string[];
  parse(filePath: string): Promise<CanonicalSession | null>;
}

const BUILT_IN_SOURCES: SourceConfig[] = [
  {
    name: "claude-code",
    rootPath: paths.rawClaudeCode,
    inputMode: "synced-files",
    listFiles: listClaudeCodeJsonl,
    parse: parseClaudeCodeFile,
  },
  {
    name: "cursor",
    rootPath: paths.rawCursor,
    inputMode: "synced-files",
    listFiles: listCursorJsonl,
    parse: parseCursorFile,
  },
  // File-based opencode (older versions): kept for archives users may still
  // have in `<app-data>/agentmine/sessions/opencode/session/...`. Returns 0 files on installs
  // that have moved to the SQLite backend, in which case the `opencode-db`
  // source below picks up the data.
  {
    name: "opencode",
    rootPath: paths.rawOpencode,
    inputMode: "synced-files",
    listFiles: listOpencodeSessions,
    parse: parseOpencodeSession,
  },
  // SQLite-backed opencode (current versions). The "rootPath" is the DB file
  // itself; "files" are session IDs; the parser opens the DB once via a
  // cached handle and reads one session at a time.
  {
    name: "opencode-db",
    rootPath: paths.sourceOpencodeDb,
    inputMode: "live-database",
    listFiles: listOpencodeDbSessions,
    parse: parseOpencodeDbSessionId,
  },
  {
    name: "codex",
    rootPath: paths.rawCodex,
    inputMode: "synced-files",
    listFiles: listCodexJsonl,
    parse: parseCodexFile,
  },
  {
    name: "gemini",
    rootPath: paths.rawGemini,
    inputMode: "synced-files",
    listFiles: listGeminiJsonl,
    parse: parseGeminiFile,
  },
  {
    name: "qwen",
    rootPath: paths.rawQwen,
    inputMode: "synced-files",
    listFiles: listQwenJsonl,
    parse: parseQwenFile,
  },
  // SQLite-backed Kilo Code (opencode-lineage store). Like opencode-db, the
  // "rootPath" is the DB file itself and "files" are session IDs read from a
  // cached readonly handle. Kilo has no file-based generation to mirror.
  {
    name: "kilo",
    rootPath: paths.sourceKiloDb,
    inputMode: "live-database",
    listFiles: listKiloDbSessions,
    parse: parseKiloDbSessionId,
  },
  // SQLite-backed Goose. One global `sessions.db` holds every session; like
  // opencode-db/kilo the "rootPath" is the DB file and "files" are session IDs
  // read from a cached readonly handle. Goose has no file-based generation.
  {
    name: "goose",
    rootPath: paths.sourceGooseDb,
    inputMode: "live-database",
    listFiles: listGooseDbSessions,
    parse: parseGooseDbSessionId,
  },
  // File-based Cline. `sync` mirrors Cline's resolved sessions directory into
  // rawCline. The parser reads every mirrored *.messages.json artifact plus its
  // optional same-stem metadata sibling.
  {
    name: "cline",
    rootPath: paths.rawCline,
    inputMode: "synced-files",
    listFiles: listClineSessions,
    freshnessSiblings: listClineMetadataSibling,
    parse: parseClineFile,
  },
  // File-based GitHub Copilot CLI. `sync` mirrors Copilot's `session-state`
  // directory into rawCopilot. The parser reads every mirrored session dir's
  // `events.jsonl` typed event stream (the lossless source of truth).
  {
    name: "copilot",
    rootPath: paths.rawCopilot,
    inputMode: "synced-files",
    listFiles: listCopilotSessions,
    parse: parseCopilotFile,
  },
];

export const normalizeCommand = defineCommand({
  meta: {
    name: "normalize",
    description:
      "Parse raw session archives (claude-code + cursor + opencode + codex + gemini + qwen + kilo + goose + cline + copilot) into the agentmine SQLite corpus",
  },
  args: {
    force: {
      type: "boolean",
      default: false,
      description: "Reprocess all sessions, ignoring content-hash cache",
    },
    "no-redact": {
      type: "boolean",
      default: false,
      description: "Skip secret redaction (default is on)",
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Parse + count redactions without writing to the DB",
    },
    source: {
      type: "string",
      description:
        "Filter to one source: claude-code | cursor | opencode | opencode-db | codex | gemini | qwen | kilo | goose | cline | copilot",
    },
    since: {
      type: "string",
      description:
        "Only parse files modified within this window (e.g. '1d', '2w', '2026-05-08'). Skips older archives; SQLite-backed sources (opencode-db, kilo, and goose) are unaffected.",
    },
  },
  async run({ args }) {
    await runCommand({
      command: "agentmine normalize",
      handler: async () => {
        const ext = await loadExtensions();
        const allSources: SourceConfig[] = [
          ...BUILT_IN_SOURCES,
          ...(ext.adapters ?? []),
        ];
        const extraRules: RedactionRule[] = ext.redactPatterns ?? [];
        const sources = resolveSources(args.source, allSources);
        const projectPathAllow = getProjectPathAllowFromEnv();

        const sinceSec = args.since ? parseSince(String(args.since)) : null;
        if (args.since && sinceSec === null) {
          throw Errors.invalidInput(
            `Invalid --since value '${String(args.since)}' (expected e.g. '1d', '2w', '12h', or 'YYYY-MM-DD')`,
          );
        }

        const codexLineageBackfill =
          sources.some((source) => source.name === "codex") &&
          codexLineageBackfillIsPending();

        let fileSets = await Promise.all(
          sources.map(async (s) => ({
            source: s,
            files: await s.listFiles(s.rootPath),
          })),
        );

        if (sinceSec !== null) {
          fileSets = await Promise.all(
            fileSets.map(async (fs) => ({
              source: fs.source,
              files:
                codexLineageBackfill && fs.source.name === "codex"
                  ? fs.files
                  : await filterFilesBySince(
                      fs.files,
                      sinceSec,
                      fs.source.freshnessSiblings,
                    ),
            })),
          );
        }

        const totalFiles = fileSets.reduce((a, b) => a + b.files.length, 0);
        if (totalFiles === 0) {
          // With a --since window, finding nothing recent is a normal no-op,
          // not an error — the corpus is simply already current.
          if (sinceSec !== null) {
            return {
              data: {
                sources: sources.map((s) => s.name),
                files_scanned: 0,
                processed: 0,
                processed_by_source: {},
                skipped_up_to_date: 0,
                skipped_empty: 0,
                skipped_by_filter: 0,
                failed: 0,
                workflow_runs: 0,
                workflow_runs_skipped: 0,
                redactions: 0,
                redactions_by_source: {},
                redacted: !args["no-redact"],
                dry_run: Boolean(args["dry-run"]),
                since_epoch: sinceSec,
                db_path: getDbPath(),
                ...(projectPathAllow
                  ? { project_path_allow: projectPathAllow.raw }
                  : {}),
              },
            };
          }
          throw Errors.notFound(
            `No input files found under any enabled source root (${sources
              .map((s) => s.rootPath)
              .join(", ")}). ${missingInputRecovery(sources)}`,
          );
        }

        reportProgressImmediate("normalize.start", {
          files: totalFiles,
          sources: sources.map((s) => s.name),
          ...(codexLineageBackfill ? { codex_lineage_backfill: true } : {}),
        });

        const redact = !args["no-redact"];
        const dryRun = Boolean(args["dry-run"]);

        // Serialize the write phase against concurrent agentmine writers (e.g. a
        // SessionStart hook's `normalize` racing a scheduled `ingest`). A dry run
        // writes no session data, so it skips the lock.
        const doNormalize = async () => {
          const dbPath = getDbPath();
          const db = dryRun
            ? dbExists(dbPath)
              ? openDb({ readonly: true, init: false, path: dbPath })
              : openDb({ path: ":memory:" })
            : openDb();

          let processed = 0;
          let skippedCached = 0;
          let skippedEmpty = 0;
          let skippedByFilter = 0;
          let failed = 0;
          let totalRedactions = 0;
          const redactionsBySource: Record<string, number> = {};
          const processedBySource: Record<string, number> = {};
          const failures: Array<{ path: string; error: string }> = [];

          let scanned = 0;
          const BATCH = 50;
          for (const { source, files } of fileSets) {
            for (let start = 0; start < files.length; start += BATCH) {
              const batch = files.slice(start, start + BATCH);
              const parsed = await Promise.all(
                batch.map(async (file) => {
                  try {
                    return {
                      file,
                      session: await source.parse(file),
                      parseError: null as string | null,
                    };
                  } catch (e) {
                    return {
                      file,
                      session: null,
                      parseError: (e as Error).message,
                    };
                  }
                }),
              );

              const upsert = db.transaction(() => {
                for (const { file, session, parseError } of parsed) {
                  if (parseError) {
                    failed += 1;
                    failures.push({
                      path: relative(source.rootPath, file),
                      error: parseError,
                    });
                    continue;
                  }
                  if (!session) {
                    skippedEmpty += 1;
                    continue;
                  }
                  if (
                    !projectPathMatchesAllow(
                      session.projectPath,
                      projectPathAllow,
                    )
                  ) {
                    skippedByFilter += 1;
                    continue;
                  }
                  if (
                    !args.force &&
                    !codexLineageBackfill &&
                    sessionIsUpToDate(db, session.id, session.contentHash)
                  ) {
                    skippedCached += 1;
                    continue;
                  }
                  if (redact) {
                    const n = redactSession(session, extraRules);
                    session.redactionCount = n;
                    totalRedactions += n;
                    if (n > 0) {
                      redactionsBySource[session.source] =
                        (redactionsBySource[session.source] ?? 0) + n;
                    }
                  }
                  if (dryRun) {
                    processed += 1;
                    processedBySource[session.source] =
                      (processedBySource[session.source] ?? 0) + 1;
                    continue;
                  }
                  try {
                    upsertSession(db, session);
                    processed += 1;
                    processedBySource[session.source] =
                      (processedBySource[session.source] ?? 0) + 1;
                  } catch (e) {
                    failed += 1;
                    failures.push({
                      path: relative(source.rootPath, file),
                      error: (e as Error).message,
                    });
                  }
                }
              });
              upsert();

              scanned += batch.length;
              reportProgress("normalize", {
                source: source.name,
                current: scanned,
                total: totalFiles,
                processed,
                skippedCached,
                skippedEmpty,
                skippedByFilter,
                failed,
                totalRedactions,
              });
            }
          }

          // Lossless raw ingest of Claude Code workflow runs (manifest +
          // journal) — a supra-session grain the transcript walker doesn't
          // cover. Runs only when the claude-code source is in scope and its
          // mirror exists; its own content-hash cache skips unchanged runs.
          let workflowRuns = 0;
          let workflowSkipped = 0;
          if (
            sources.some((s) => s.name === "claude-code") &&
            existsSync(paths.rawClaudeCode)
          ) {
            const wf = await ingestWorkflowRuns(db, paths.rawClaudeCode, {
              dryRun,
            });
            workflowRuns = wf.runs;
            workflowSkipped = wf.skipped;
          }

          if (codexLineageBackfill && !dryRun && failed === 0) {
            // A failure-free all-source run can still see an incomplete Codex
            // mirror. The migration invalidates every legacy Codex hash, so
            // clear the marker only after every such row has been rewritten.
            // Otherwise restored old-mtime files would be skipped by --since.
            const pendingCodexRows =
              db
                .prepare<[], { count: number }>(
                  `SELECT COUNT(*) AS count
                     FROM sessions
                    WHERE source = 'codex' AND content_hash IS NULL`,
                )
                .get()?.count ?? 1;
            if (pendingCodexRows === 0) {
              upsertMeta(db, CODEX_LINEAGE_BACKFILL_META_KEY, "0");
            }
          }

          db.close();
          reportProgressImmediate("normalize.done", {
            processed,
            skippedCached,
            skippedEmpty,
            skippedByFilter,
            failed,
            totalRedactions,
          });

          const status: "success" | "partial" =
            failed > 0 ? "partial" : "success";
          const errors = failures.slice(0, 10).map((f) => ({
            code: 2100,
            name: "PARSE_FAILED",
            category: "system" as const,
            retryable: false,
            message: `Failed to normalize ${f.path}: ${f.error}`,
            path: f.path,
          }));
          return {
            status,
            data: {
              sources: sources.map((s) => s.name),
              files_scanned: totalFiles,
              processed,
              processed_by_source: processedBySource,
              skipped_up_to_date: skippedCached,
              skipped_empty: skippedEmpty,
              skipped_by_filter: skippedByFilter,
              failed,
              workflow_runs: workflowRuns,
              workflow_runs_skipped: workflowSkipped,
              redactions: totalRedactions,
              redactions_by_source: redactionsBySource,
              redacted: redact,
              dry_run: dryRun,
              ...(sinceSec !== null ? { since_epoch: sinceSec } : {}),
              ...(codexLineageBackfill ? { codex_lineage_backfill: true } : {}),
              db_path: getDbPath(),
              ...(projectPathAllow
                ? { project_path_allow: projectPathAllow.raw }
                : {}),
            },
            ...(failed > 0 ? { errors } : {}),
          };
        };

        return dryRun
          ? await doNormalize()
          : await withWriteLock(
              { command: "agentmine normalize" },
              doNormalize,
            );
      },
    });
  },
});

function codexLineageBackfillIsPending(): boolean {
  const dbPath = getDbPath();
  if (!dbExists(dbPath)) return false;

  const db = openDb({ readonly: true, init: false, path: dbPath });
  try {
    const schemaVersion = Number.parseInt(
      getMeta(db, "schema_version") ?? "0",
      10,
    );
    return (
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion < 14 ||
      getMeta(db, CODEX_LINEAGE_BACKFILL_META_KEY) === "1"
    );
  } catch {
    // An old corpus without readable migration metadata needs the conservative
    // full Codex pass. The normal writable open will surface genuine DB errors.
    return true;
  } finally {
    db.close();
  }
}

function resolveSources(
  flag: unknown,
  sources: SourceConfig[],
): SourceConfig[] {
  if (!flag) return sources;
  const name = String(flag);
  const match = sources.find((s) => s.name === name);
  if (!match) {
    throw Errors.invalidInput(
      `--source must be one of ${sources.map((s) => s.name).join("|")} (got '${name}')`,
    );
  }
  return [match];
}

function missingInputRecovery(sources: SourceConfig[]): string {
  const synced = sources.filter(
    (source) => source.inputMode === "synced-files",
  );
  const live = sources.filter((source) => source.inputMode === "live-database");
  const configured = sources.filter((source) => source.inputMode === undefined);
  const actions: string[] = [];

  if (synced.length > 0) {
    actions.push("run `agentmine sync` for the file-backed sources");
  }
  if (live.length > 0) {
    actions.push(
      `check that the live SQLite database for ${live
        .map((source) => source.name)
        .join("/")} exists and contains sessions`,
    );
  }
  if (configured.length > 0) {
    actions.push("check the configured extension source paths");
  }

  const lastAction = actions.at(-1);
  if (lastAction === undefined) return "Check the configured source paths.";

  const guidance =
    actions.length === 1
      ? lastAction
      : `${actions.slice(0, -1).join(", ")}, and ${lastAction}`;
  return `${guidance.charAt(0).toUpperCase()}${guidance.slice(1)}.`;
}

/**
 * Drop files whose on-disk mtime is older than `sinceSec` (unix epoch
 * seconds), so the caller can skip the expensive parse of stale archives.
 * Entries that cannot be stat'd are KEPT — that covers non-path "files"
 * such as the opencode-db session IDs, leaving that source unaffected.
 */
export async function filterFilesBySince(
  files: string[],
  sinceSec: number,
  freshnessSiblings?: (filePath: string) => string[],
): Promise<string[]> {
  const kept = await Promise.all(
    files.map(async (file) => {
      try {
        const st = await stat(file);
        if (st.mtimeMs / 1000 >= sinceSec) return file;
      } catch {
        return file;
      }

      for (const sibling of freshnessSiblings?.(file) ?? []) {
        try {
          const st = await stat(sibling);
          if (st.mtimeMs / 1000 >= sinceSec) return file;
        } catch {
          // Optional freshness siblings may be absent.
        }
      }
      return null;
    }),
  );
  return kept.filter((f): f is string => f !== null);
}

// ---------- Claude Code walker ----------
async function listClaudeCodeJsonl(root: string): Promise<string[]> {
  const out: string[] = [];
  await walkJsonl(root, out, { skipDirs: new Set() });
  return out;
}

// ---------- Cursor walker ----------
async function listCursorJsonl(root: string): Promise<string[]> {
  // Cursor archive: <root>/<encoded-project>/<uuid>/<uuid>.jsonl plus
  // <root>/<encoded-project>/<uuid>/subagents/<sub-uuid>.jsonl.
  // We include subagents (linked via parent dir in the adapter).
  const out: string[] = [];
  await walkJsonl(root, out, { skipDirs: new Set() });
  return out;
}

// ---------- opencode walker ----------
async function listOpencodeSessions(root: string): Promise<string[]> {
  // opencode stores session JSON under <root>/session/<projectId>/ses_*.json.
  const out: string[] = [];
  const sessionDir = join(root, "session");
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(sessionDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => join(sessionDir, d.name));
  } catch {
    return out;
  }
  for (const pd of projectDirs) {
    const files = await readdir(pd).catch(() => null);
    if (files === null) continue;
    for (const f of files) {
      if (!f.startsWith("ses_") || !f.endsWith(".json")) continue;
      const full = join(pd, f);
      try {
        const st = await stat(full);
        if (st.size > 0) out.push(full);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

// ---------- opencode (SQLite DB) walker ----------
let cachedOpencodeDb: { path: string; db: Database } | null = null;

function getOpencodeDb(dbPath: string): Database | null {
  if (!existsSync(dbPath)) return null;
  if (cachedOpencodeDb && cachedOpencodeDb.path === dbPath)
    return cachedOpencodeDb.db;
  if (cachedOpencodeDb) cachedOpencodeDb.db.close();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  cachedOpencodeDb = { path: dbPath, db };
  return db;
}

async function listOpencodeDbSessions(root: string): Promise<string[]> {
  const db = getOpencodeDb(root);
  if (!db) return [];
  return listOpencodeSessionIds(db);
}

async function parseOpencodeDbSessionId(
  sessionId: string,
): Promise<CanonicalSession | null> {
  if (!cachedOpencodeDb) return null;
  return parseOpencodeSessionFromDb(
    cachedOpencodeDb.db,
    sessionId,
    cachedOpencodeDb.path,
  );
}

// ---------- Kilo Code (SQLite DB) walker ----------
let cachedKiloDb: { path: string; db: Database } | null = null;

function getKiloDb(dbPath: string): Database | null {
  if (!existsSync(dbPath)) return null;
  if (cachedKiloDb && cachedKiloDb.path === dbPath) return cachedKiloDb.db;
  if (cachedKiloDb) cachedKiloDb.db.close();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  cachedKiloDb = { path: dbPath, db };
  return db;
}

async function listKiloDbSessions(root: string): Promise<string[]> {
  const db = getKiloDb(root);
  if (!db) return [];
  return listKiloSessionIds(db);
}

async function parseKiloDbSessionId(
  sessionId: string,
): Promise<CanonicalSession | null> {
  if (!cachedKiloDb) return null;
  return parseKiloSessionFromDb(cachedKiloDb.db, sessionId, cachedKiloDb.path);
}

// ---------- Goose (SQLite DB) walker ----------
let cachedGooseDb: { path: string; db: Database } | null = null;

function getGooseDb(dbPath: string): Database | null {
  if (!existsSync(dbPath)) return null;
  if (cachedGooseDb && cachedGooseDb.path === dbPath) return cachedGooseDb.db;
  if (cachedGooseDb) cachedGooseDb.db.close();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  cachedGooseDb = { path: dbPath, db };
  return db;
}

async function listGooseDbSessions(root: string): Promise<string[]> {
  const db = getGooseDb(root);
  if (!db) return [];
  return listGooseSessionIds(db);
}

async function parseGooseDbSessionId(
  sessionId: string,
): Promise<CanonicalSession | null> {
  if (!cachedGooseDb) return null;
  return parseGooseSessionFromDb(
    cachedGooseDb.db,
    sessionId,
    cachedGooseDb.path,
  );
}

// ---------- Cline walker ----------
const CLINE_MESSAGES_SUFFIX = ".messages.json";

export function listClineMetadataSibling(messagesPath: string): string[] {
  if (!messagesPath.endsWith(CLINE_MESSAGES_SUFFIX)) return [];
  return [`${messagesPath.slice(0, -CLINE_MESSAGES_SUFFIX.length)}.json`];
}

async function listClineSessions(root: string): Promise<string[]> {
  // Cline stores root sessions as <root>/<id>/<id>.messages.json. Current
  // subagent/team sessions add other *.messages.json siblings to that same
  // directory, so enumerate every nonempty messages artifact one level down.
  // Real paths keep the --since mtime filter working.
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(
    () => null,
  );
  if (entries === null) return out;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = join(root, entry.name);
    const artifacts = await readdir(sessionDir, { withFileTypes: true }).catch(
      () => [],
    );
    for (const artifact of artifacts) {
      if (!artifact.name.endsWith(CLINE_MESSAGES_SUFFIX)) continue;
      const messagesPath = join(sessionDir, artifact.name);
      try {
        const st = await stat(messagesPath);
        if (st.isFile() && st.size > 0) out.push(messagesPath);
      } catch {
        /* artifact disappeared during enumeration — skip */
      }
    }
  }
  return out.sort();
}

// ---------- Copilot walker ----------
async function listCopilotSessions(root: string): Promise<string[]> {
  // Copilot stores each session as <root>/<uuid>/events.jsonl (the typed event
  // stream). Enumerate every nonempty events.jsonl one level down; real paths
  // keep the --since mtime filter working.
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(
    () => null,
  );
  if (entries === null) return out;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const eventsPath = join(root, entry.name, "events.jsonl");
    try {
      const st = await stat(eventsPath);
      if (st.isFile() && st.size > 0) out.push(eventsPath);
    } catch {
      /* no events.jsonl in this dir — skip */
    }
  }
  return out.sort();
}

// ---------- Codex walker ----------
async function listCodexJsonl(root: string): Promise<string[]> {
  // Codex archive: <root>/YYYY/MM/DD/rollout-*.jsonl
  const out: string[] = [];
  await walkJsonl(root, out, { skipDirs: new Set() });
  return out;
}

// ---------- Gemini walker ----------
async function listGeminiJsonl(root: string): Promise<string[]> {
  // Gemini archive: <root>/<project-id>/chats/session-*.jsonl plus nested
  // subagent files under <project-id>/chats/<parent-id>/<session-id>.jsonl.
  const out: string[] = [];
  await walkJsonl(root, out, { skipDirs: new Set() });
  return out;
}

// ---------- Qwen walker ----------
async function listQwenJsonl(root: string): Promise<string[]> {
  // Qwen archive: <root>/<cwd-slug>/chats/<sessionId>.jsonl.
  const out: string[] = [];
  await walkJsonl(root, out, { skipDirs: new Set() });
  return out;
}

// ---------- Shared recursive JSONL walker ----------
async function walkJsonl(
  dir: string,
  out: string[],
  opts: { skipDirs: Set<string> },
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (opts.skipDirs.has(entry.name)) continue;
      await walkJsonl(full, out, opts);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const st = await stat(full);
        if (st.size > 0) out.push(full);
      } catch {
        /* skip */
      }
    }
  }
}
