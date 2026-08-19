import type { CliWarning } from "../contract/result.js";
import { VERSION } from "../version.js";
import {
  type DatabaseType,
  EXTRACT_READY_META_KEY,
  getMeta,
  upsertMeta,
} from "./client.js";
import { readSupervisionSnapshot, supervisionWarnings } from "./supervision.js";

export const LAST_NORMALIZE_AT_META_KEY = "last_normalize_at";
export const LAST_EXTRACT_AT_META_KEY = "last_extract_at";
export const LAST_EXTRACT_VERSION_META_KEY = "last_extract_version";
export const WORKFLOW_EXTRACT_PENDING_META_KEY = "workflow_extract_pending";

export interface FreshnessSnapshot {
  last_normalize_at: string | null;
  last_extract_at: string | null;
  /**
   * The agentmine version that last fully repopulated the fact tables (an
   * `extract --force` run, or the first-ever extract on a corpus). `null`
   * means either no full extract has ever run, or the corpus predates
   * version tracking (pre-0.11.1) — both are treated as "older, unknown".
   */
  last_extract_version: string | null;
  full_rebuild_pending: boolean;
  pending_extraction_sessions: number;
  workflow_extraction_pending: boolean;
  oldest_pending_session_started_at: string | null;
  newest_pending_session_started_at: string | null;
  facts_current: boolean;
}

interface FreshnessRow {
  last_normalize_at: string | null;
  last_extract_at: string | null;
  last_extract_version: string | null;
  full_rebuild_pending: number;
  pending_extraction_sessions: number;
  workflow_extraction_pending: number;
  oldest_started_at: number | null;
  newest_started_at: number | null;
}

export function readFreshnessSnapshot(db: DatabaseType): FreshnessSnapshot {
  const row = db
    .prepare<[string, string, string, string, string, string], FreshnessRow>(
      `SELECT (SELECT value FROM meta WHERE key = ?) AS last_normalize_at,
              (SELECT value FROM meta WHERE key = ?) AS last_extract_at,
              (SELECT value FROM meta WHERE key = ?) AS last_extract_version,
              CASE
                WHEN (SELECT value FROM meta WHERE key = ?) = '1' THEN 0
                ELSE 1
              END AS full_rebuild_pending,
              CASE
                WHEN (SELECT value FROM meta WHERE key = ?) = '0' THEN 0
                WHEN (SELECT value FROM meta WHERE key = ?) IS NOT NULL THEN 1
                WHEN EXISTS (SELECT 1 FROM raw_workflow_runs LIMIT 1) THEN 1
                ELSE 0
              END AS workflow_extraction_pending,
              COUNT(*) AS pending_extraction_sessions,
              MIN(s.started_at) AS oldest_started_at,
              MAX(s.started_at) AS newest_started_at
         FROM dirty_sessions d
         LEFT JOIN sessions s ON s.id = d.session_id`,
    )
    .get(
      LAST_NORMALIZE_AT_META_KEY,
      LAST_EXTRACT_AT_META_KEY,
      LAST_EXTRACT_VERSION_META_KEY,
      EXTRACT_READY_META_KEY,
      WORKFLOW_EXTRACT_PENDING_META_KEY,
      WORKFLOW_EXTRACT_PENDING_META_KEY,
    ) ?? {
    last_normalize_at: null,
    last_extract_at: null,
    last_extract_version: null,
    full_rebuild_pending: 1,
    pending_extraction_sessions: 0,
    workflow_extraction_pending: 0,
    oldest_started_at: null,
    newest_started_at: null,
  };

  return {
    last_normalize_at: row.last_normalize_at,
    last_extract_at: row.last_extract_at,
    last_extract_version: row.last_extract_version,
    pending_extraction_sessions: row.pending_extraction_sessions,
    workflow_extraction_pending: row.workflow_extraction_pending === 1,
    oldest_pending_session_started_at: toIso(row.oldest_started_at),
    newest_pending_session_started_at: toIso(row.newest_started_at),
    full_rebuild_pending: row.full_rebuild_pending === 1,
    facts_current:
      row.pending_extraction_sessions === 0 &&
      row.workflow_extraction_pending !== 1 &&
      row.full_rebuild_pending !== 1,
  };
}

/** Read fact-backed data and its freshness marker from one SQLite snapshot. */
export function readWithFreshnessSnapshot<T>(
  db: DatabaseType,
  read: () => T,
): { value: T; freshness: FreshnessSnapshot } {
  return db.transaction(() => {
    const value = read();
    return { value, freshness: readFreshnessSnapshot(db) };
  })();
}

export function recordNormalizeSuccess(
  db: DatabaseType,
  completedAt = new Date(),
): void {
  upsertMeta(db, LAST_NORMALIZE_AT_META_KEY, completedAt.toISOString());
}

export function recordExtractSuccess(
  db: DatabaseType,
  completedAt = new Date(),
): void {
  upsertMeta(db, LAST_EXTRACT_AT_META_KEY, completedAt.toISOString());
}

/**
 * Record which agentmine version's derivation logic the fact tables now
 * reflect in full. Callers must only invoke this after a rebuild that
 * covers the WHOLE corpus (a full/first-ever extract, or `--force`) — an
 * incremental run that rebuilds only dirty sessions leaves the rest of the
 * corpus derived by whatever version last fully rebuilt it, so it must not
 * advance this marker (see AGENTS.md: "Changing derivation does not fix
 * stored rows; that needs `extract --force`").
 */
export function recordExtractVersion(db: DatabaseType, version: string): void {
  upsertMeta(db, LAST_EXTRACT_VERSION_META_KEY, version);
}

export function markWorkflowExtractionPending(db: DatabaseType): void {
  upsertMeta(db, WORKFLOW_EXTRACT_PENDING_META_KEY, "1");
}

export function clearWorkflowExtractionPending(db: DatabaseType): void {
  upsertMeta(db, WORKFLOW_EXTRACT_PENDING_META_KEY, "0");
}

export function workflowExtractionIsPending(db: DatabaseType): boolean {
  const marker = getMeta(db, WORKFLOW_EXTRACT_PENDING_META_KEY);
  if (marker !== undefined) return marker !== "0";
  return Boolean(
    db
      .prepare<[], { pending: number }>(
        `SELECT 1 AS pending FROM raw_workflow_runs LIMIT 1`,
      )
      .get(),
  );
}

export function extractionPendingWarnings(
  freshness: FreshnessSnapshot,
): CliWarning[] {
  const pending = [
    ...(freshness.pending_extraction_sessions > 0
      ? [`${freshness.pending_extraction_sessions} normalized session(s)`]
      : []),
    ...(freshness.workflow_extraction_pending ? ["workflow data"] : []),
  ];
  if (pending.length === 0) return [];
  return [
    {
      name: "EXTRACTION_PENDING",
      message: `Pending fact extraction covers ${pending.join(" and ")}, so derived fact tables may be incomplete. Run \`agentmine extract\` before relying on fact-derived results.`,
    },
  ];
}

/**
 * Warn when the fact tables were last fully populated by a different (or
 * unrecorded) agentmine version than the one currently running. Derivation
 * logic can change without a schema change (see AGENTS.md: "Shell-derived
 * facts come from a parse, never a match"), so a version mismatch is a
 * distinct staleness signal from `EXTRACTION_PENDING` — the dirty-session
 * tracker only knows about new/changed *inputs*, not about a code change
 * that reinterprets inputs it already processed. A corpus with no recorded
 * version at all (every pre-0.11.1 corpus, or one that has never run a full
 * extract) is treated the same as a mismatch: older, unknown.
 */
/**
 * A full rebuild has been scheduled and has not run yet.
 *
 * Scheduled by an upgrade that changed how facts are derived: the migration
 * clears the incremental marker, which is what makes the next ordinary
 * `extract` rebuild everything. Deliberately NOT keyed on the running version
 * differing from the recorded one -- that fires on every release, including
 * ones that changed no derivation at all, and a warning that cries wolf on
 * every upgrade is one consumers learn to ignore. The recorded version is
 * still reported, because it is what makes the warning diagnosable.
 */
export function factsFromOlderVersionWarnings(
  freshness: FreshnessSnapshot,
): CliWarning[] {
  if (!freshness.full_rebuild_pending) return [];
  const derivedBy = freshness.last_extract_version
    ? `Fact tables were last fully derived by agentmine ${freshness.last_extract_version}`
    : "Fact tables have no recorded derivation version";
  return [
    {
      name: "FACTS_FROM_OLDER_VERSION",
      message: `${derivedBy}, and the running agentmine ${VERSION} has scheduled a full rebuild because its fact derivation changed. Run \`agentmine extract\` to perform it.`,
    },
  ];
}

/**
 * Every warning a read command owes its caller about the state of the corpus
 * behind the answer.
 *
 * One funnel on purpose. These are three different claims — whether derived
 * facts have caught up with normalized inputs, whether those facts were
 * derived by the version currently running, and whether the machine is
 * still feeding the corpus at all — and a command that reported one but not
 * the others would be silently wrong in whichever direction it forgot.
 */
export function readCommandWarnings(
  db: DatabaseType,
  freshness: FreshnessSnapshot,
): CliWarning[] {
  return [
    ...extractionPendingWarnings(freshness),
    ...factsFromOlderVersionWarnings(freshness),
    ...supervisionWarnings(readSupervisionSnapshot(db)),
  ];
}

function toIso(epochSeconds: number | null): string | null {
  return epochSeconds === null
    ? null
    : new Date(epochSeconds * 1000).toISOString();
}
