/**
 * What the corpus knows about being kept current.
 *
 * A heartbeat alone cannot answer the question that matters. A corpus with no
 * recent daemon cycle is either a machine where nobody ever asked for one — in
 * which case there is nothing to report — or a machine where somebody did and it
 * has stopped, which is the silent failure every consumer downstream inherits.
 * The two are indistinguishable unless the asking itself is recorded, so it is
 * recorded here, next to the heartbeat it qualifies.
 *
 * This lives in the database layer rather than the daemon's, because it is
 * durable state about the corpus that read commands consult long after any
 * daemon process is gone.
 */
import { existsSync } from "node:fs";
import { z } from "zod";
import type { CliWarning } from "../contract/result.js";
import { type DatabaseType, getMeta, upsertMeta } from "./client.js";

/** Last time a daemon cycle completed, UTC ISO. */
export const DAEMON_HEARTBEAT_META_KEY = "last_daemon_cycle_at";
/** When the running daemon started, UTC ISO. */
export const DAEMON_STARTED_META_KEY = "daemon_started_at";
/** The operator's standing declaration that this corpus is continuously fed. */
export const DAEMON_SUPERVISION_META_KEY = "daemon_supervision";
/** Why the last daemon stood down, when it did so deliberately. */
export const DAEMON_STAND_DOWN_META_KEY = "daemon_stood_down";

export const serviceKindSchema = z.enum(["systemd", "launchd"]);
export type ServiceKind = z.infer<typeof serviceKindSchema>;

/**
 * Written when a service definition is installed.
 *
 * The definition's own path is part of the record because the declaration is
 * only meaningful while the definition it describes exists: an operator who
 * removes the file has withdrawn the declaration, and nothing else would tell
 * us so.
 */
export const supervisionRecordSchema = z.object({
  kind: serviceKindSchema,
  definition_path: z.string().min(1),
  program_path: z.string().min(1),
  installed_at: z.string().min(1),
});
export type SupervisionRecord = z.infer<typeof supervisionRecordSchema>;

/**
 * Why a daemon stopped on purpose.
 *
 * Named rather than free text because a restart caused by an upgrade and a
 * restart caused by a fault look identical in a supervisor's logs, and the
 * difference decides whether an operator needs to do anything.
 */
export const standDownReasonSchema = z.enum([
  "program-replaced",
  "program-missing",
  "corpus-migrated",
]);
export type StandDownReason = z.infer<typeof standDownReasonSchema>;

export const standDownRecordSchema = z.object({
  reason: standDownReasonSchema,
  detail: z.string().min(1),
  at: z.string().min(1),
});
export type StandDownRecord = z.infer<typeof standDownRecordSchema>;

/**
 * How long a declared-but-silent corpus waits before reads say so.
 *
 * The slowest stated detection bound, because that is the longest a healthy
 * daemon may legitimately go without completing a cycle. Reporting sooner would
 * call a working machine broken. Pinned against the band defaults by a test, so
 * retuning one without the other fails rather than drifts.
 */
export const SUPERVISION_STALE_AFTER_MS = 60 * 60 * 1000;

export interface SupervisionSnapshot {
  /** The declaration, when one is on record and still applies. */
  declared: SupervisionRecord | undefined;
  /** False when the declaration names a definition that is no longer there. */
  definition_present: boolean;
  last_daemon_cycle_at: string | null;
  stood_down: StandDownRecord | undefined;
  /** Declared, and no cycle within the slowest stated bound. */
  supervision_stalled: boolean;
}

export function recordSupervision(
  db: DatabaseType,
  record: SupervisionRecord,
): void {
  upsertMeta(db, DAEMON_SUPERVISION_META_KEY, JSON.stringify(record));
}

export function readSupervision(
  db: DatabaseType,
): SupervisionRecord | undefined {
  return parseMeta(getMeta(db, DAEMON_SUPERVISION_META_KEY), (value) =>
    supervisionRecordSchema.safeParse(value),
  );
}

export function recordStandDown(
  db: DatabaseType,
  record: StandDownRecord,
): void {
  upsertMeta(db, DAEMON_STAND_DOWN_META_KEY, JSON.stringify(record));
}

export function readStandDown(db: DatabaseType): StandDownRecord | undefined {
  return parseMeta(getMeta(db, DAEMON_STAND_DOWN_META_KEY), (value) =>
    standDownRecordSchema.safeParse(value),
  );
}

/**
 * Cleared when a daemon starts, so a stand-down reason always describes the
 * daemon that is currently absent rather than one two restarts ago.
 */
export function clearStandDown(db: DatabaseType): void {
  upsertMeta(db, DAEMON_STAND_DOWN_META_KEY, "");
}

export function readSupervisionSnapshot(
  db: DatabaseType,
  now: Date = new Date(),
  definitionExists: (path: string) => boolean = existsSync,
): SupervisionSnapshot {
  const record = readSupervision(db);
  // A declaration outlives the process it describes but not the file: removing
  // the definition is the documented way to withdraw it, and it is the only
  // signal available, since disabling a service leaves nothing behind to read.
  const present =
    record === undefined ? false : definitionExists(record.definition_path);
  const declared = present ? record : undefined;
  const lastCycle = getMeta(db, DAEMON_HEARTBEAT_META_KEY) ?? null;
  const cycleAgeMs =
    lastCycle === null ? undefined : now.getTime() - Date.parse(lastCycle);

  return {
    declared,
    definition_present: present,
    last_daemon_cycle_at: lastCycle,
    stood_down: readStandDown(db),
    supervision_stalled:
      declared !== undefined &&
      (cycleAgeMs === undefined ||
        Number.isNaN(cycleAgeMs) ||
        cycleAgeMs >= SUPERVISION_STALE_AFTER_MS),
  };
}

/**
 * The report a read command makes when the machine is not honoring its own
 * declaration. Read time is the moment it matters: it is when a stale answer
 * would otherwise be believed.
 */
export function supervisionWarnings(
  snapshot: SupervisionSnapshot,
): CliWarning[] {
  if (!snapshot.supervision_stalled) return [];
  const declared = snapshot.declared;
  if (declared === undefined) return [];

  const since =
    snapshot.last_daemon_cycle_at === null
      ? "has never completed a cycle"
      : `has not completed a cycle since ${snapshot.last_daemon_cycle_at}`;
  const because =
    snapshot.stood_down === undefined
      ? ""
      : ` It stood down at ${snapshot.stood_down.at}: ${snapshot.stood_down.detail}`;

  return [
    {
      name: "DAEMON_NOT_RUNNING",
      message:
        `Continuous ingest is installed for this corpus (${declared.kind}) but ` +
        `${since}, so results may be missing recent sessions.${because} ` +
        "Check the service, or remove the definition to stop reporting this.",
      path: declared.definition_path,
    },
  ];
}

function parseMeta<T>(
  raw: string | undefined,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): T | undefined {
  if (raw === undefined || raw === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Meta a different version wrote, or wrote badly. An unreadable
    // declaration is treated as no declaration: refusing to answer a read
    // command over it would be a worse failure than the one it describes.
    return undefined;
  }
  const parsed = parse(value);
  return parsed.success ? parsed.data : undefined;
}
