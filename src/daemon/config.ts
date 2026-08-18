/**
 * Daemon configuration: which sources are watched, and how often each recency
 * band is rescanned.
 *
 * Band intervals are the observable contract: detection latency is a
 * function of how recently a location was written, so each band's interval is
 * the bound this capability promises for files that fall in it. They are
 * configurable rather than constant because the defaults are tuned to one
 * corpus on one machine.
 */
import { dirname } from "node:path";
import { z } from "zod";
import { paths } from "../config.js";

/** How a source is imported: a mirrored file tree, or a database read in place. */
export const sourceKindSchema = z.enum(["mirror", "db"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export interface DaemonSource {
  /**
   * The value `agentmine normalize --source` accepts.
   *
   * NOT always the value stored in `sessions.source`: the live opencode
   * database is imported as `opencode-db` but lands in the corpus as
   * `opencode`. Passing the corpus name selects the legacy FILE mirror, which
   * on a database-only machine holds nothing — so the import reports a clean
   * run having imported none of the live database.
   */
  name: string;
  /** The value that appears in `sessions.source`. */
  corpusName: string;
  kind: SourceKind;
  /** Directory tree (mirror) or database file (db). */
  path: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const bandSchema = z.object({
  name: z.string().min(1),
  /**
   * Upper bound on "time since last write" for membership. `null` is the
   * catch-all band — every file older than the previous band belongs to it.
   */
  maxAgeMs: z.number().int().positive().nullable(),
  /** How often this band is rescanned. Also its stated detection bound. */
  intervalMs: z.number().int().positive(),
});
export type Band = z.infer<typeof bandSchema>;

/**
 * Three file bands, ordered fastest first. Boundaries come from the measured
 * write-span distribution rather than taste: across 10,781 local transcripts
 * only 0.54% were written more than 24h after creation and only 0.03% more
 * than 7 days after, so ~99.5% of write activity falls in `hot`.
 *
 * The catch-all band's scan doubles as the full reconciliation walk, which is
 * what discovers files the index has never seen and recomputes membership.
 */
export const DEFAULT_BANDS: Band[] = [
  { name: "hot", maxAgeMs: DAY_MS, intervalMs: 2_000 },
  { name: "cool", maxAgeMs: 7 * DAY_MS, intervalMs: 5 * 60_000 },
  { name: "cold", maxAgeMs: null, intervalMs: HOUR_MS },
];

export const daemonConfigSchema = z.object({
  bands: z.array(bandSchema).min(1),
  /**
   * How often directory modification times are checked.
   *
   * Separate from the file bands because a directory's own modification time
   * is what reveals a NEWLY created session; the new file has no history to
   * place it in a band, and the directory holding it may have been dormant for
   * months. This is the measured cost centre of the whole design — directories
   * never age out of relevance the way files do.
   */
  dirIntervalMs: z.number().int().positive(),
  /** Quiet period before a dirty source is imported. */
  settleMs: z.number().int().positive(),
  /**
   * Ceiling from a source's first unserviced change. Without it a session
   * that writes continuously — the one someone is most likely watching — would
   * never import until it stopped.
   */
  ceilingMs: z.number().int().positive(),
  /** Quiet period after import activity before fact extraction runs. */
  extractSettleMs: z.number().int().positive(),
  /**
   * Ceiling from the first pending extraction. Extraction is the expensive,
   * non-source-scoped stage, so it is not run per import; without a ceiling it
   * would starve on exactly the busy days when facts matter most.
   */
  extractCeilingMs: z.number().int().positive(),
  /** `--since` window handed to each import. */
  sinceWindow: z.string().min(1),
  /**
   * How often liveness is recorded in the corpus.
   *
   * Throttled well below the tick rate on purpose: the heartbeat is a write,
   * and writing it every cycle would put a steady stream of transactions
   * through a database whose whole point is to be read. It only has to be
   * frequent enough that a stalled daemon is obvious, not frequent enough to
   * time cycles.
   */
  heartbeatIntervalMs: z.number().int().positive(),
  /**
   * How often the daemon checks whether it has been superseded.
   *
   * A stat and a meta read, so it is cheap — but not free, and nothing is
   * gained by noticing an upgrade in the same second it lands. Slow enough to
   * be invisible in the idle budget, fast enough that an operator who upgrades
   * and then immediately queries gets the new version's answer.
   */
  supersessionIntervalMs: z.number().int().positive(),
  /** Skip fact extraction entirely. */
  noExtract: z.boolean(),
  /** Restrict to these source names; empty means every present source. */
  only: z.array(z.string()).default([]),
});
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

export const DEFAULT_CONFIG: DaemonConfig = {
  bands: DEFAULT_BANDS,
  dirIntervalMs: 60_000,
  settleMs: 2_000,
  ceilingMs: 20_000,
  extractSettleMs: 60_000,
  extractCeilingMs: 15 * 60_000,
  heartbeatIntervalMs: 15_000,
  supersessionIntervalMs: 30_000,
  // Comfortably wider than the slowest band, so a cold-band detection still
  // falls inside the window the import itself filters on. `--since` is a cost
  // control for the import, not this capability's correctness boundary.
  sinceWindow: "3d",
  noExtract: false,
  only: [],
};

/** Every source agentmine can import from a local store. */
export function allSources(): DaemonSource[] {
  const mirror = (name: string, path: string): DaemonSource => ({
    name,
    corpusName: name,
    kind: "mirror",
    path,
  });
  const db = (
    name: string,
    corpusName: string,
    path: string,
  ): DaemonSource => ({ name, corpusName, kind: "db", path });

  return [
    mirror("claude-code", paths.sourceClaudeProjects),
    mirror("cursor", paths.sourceCursorProjects),
    mirror("codex", paths.sourceCodexSessions),
    mirror("gemini", paths.sourceGeminiSessions),
    mirror("qwen", paths.sourceQwenSessions),
    mirror("cline", paths.sourceClineSessions),
    mirror("copilot", paths.sourceCopilotSessions),
    mirror("pi", paths.sourcePiSessions),
    mirror("droid", paths.sourceDroidSessions),
    mirror("vibe", paths.sourceVibeSessions),
    db("opencode-db", "opencode", paths.sourceOpencodeDb),
    db("kilo", "kilo", paths.sourceKiloDb),
    db("goose", "goose", paths.sourceGooseDb),
  ];
}

/**
 * The directory a source is scanned under. A database is watched through its
 * containing directory so write-ahead-log sidecars, which is where most commits
 * land, are seen too.
 */
export function scanRoot(source: DaemonSource): string {
  return source.kind === "db" ? dirname(source.path) : source.path;
}
