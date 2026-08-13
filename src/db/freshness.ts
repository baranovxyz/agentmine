import type { CliWarning } from "../contract/result.js";
import { type DatabaseType, getMeta, upsertMeta } from "./client.js";

export const LAST_NORMALIZE_AT_META_KEY = "last_normalize_at";
export const LAST_EXTRACT_AT_META_KEY = "last_extract_at";
export const WORKFLOW_EXTRACT_PENDING_META_KEY = "workflow_extract_pending";

export interface FreshnessSnapshot {
  last_normalize_at: string | null;
  last_extract_at: string | null;
  pending_extraction_sessions: number;
  workflow_extraction_pending: boolean;
  oldest_pending_session_started_at: string | null;
  newest_pending_session_started_at: string | null;
  facts_current: boolean;
}

interface FreshnessRow {
  last_normalize_at: string | null;
  last_extract_at: string | null;
  pending_extraction_sessions: number;
  workflow_extraction_pending: number;
  oldest_started_at: number | null;
  newest_started_at: number | null;
}

export function readFreshnessSnapshot(db: DatabaseType): FreshnessSnapshot {
  const row = db
    .prepare<[string, string, string, string], FreshnessRow>(
      `SELECT (SELECT value FROM meta WHERE key = ?) AS last_normalize_at,
              (SELECT value FROM meta WHERE key = ?) AS last_extract_at,
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
      WORKFLOW_EXTRACT_PENDING_META_KEY,
      WORKFLOW_EXTRACT_PENDING_META_KEY,
    ) ?? {
    last_normalize_at: null,
    last_extract_at: null,
    pending_extraction_sessions: 0,
    workflow_extraction_pending: 0,
    oldest_started_at: null,
    newest_started_at: null,
  };

  return {
    last_normalize_at: row.last_normalize_at,
    last_extract_at: row.last_extract_at,
    pending_extraction_sessions: row.pending_extraction_sessions,
    workflow_extraction_pending: row.workflow_extraction_pending === 1,
    oldest_pending_session_started_at: toIso(row.oldest_started_at),
    newest_pending_session_started_at: toIso(row.newest_started_at),
    facts_current:
      row.pending_extraction_sessions === 0 &&
      row.workflow_extraction_pending !== 1,
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
  if (freshness.facts_current) return [];
  const pending = [
    ...(freshness.pending_extraction_sessions > 0
      ? [`${freshness.pending_extraction_sessions} normalized session(s)`]
      : []),
    ...(freshness.workflow_extraction_pending ? ["workflow data"] : []),
  ].join(" and ");
  return [
    {
      name: "EXTRACTION_PENDING",
      message: `Pending fact extraction covers ${pending}, so derived fact tables may be incomplete. Run \`agentmine extract\` before relying on fact-derived results.`,
    },
  ];
}

function toIso(epochSeconds: number | null): string | null {
  return epochSeconds === null
    ? null
    : new Date(epochSeconds * 1000).toISOString();
}
