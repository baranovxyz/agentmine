/**
 * The scheduler.
 *
 * Time is injected and every decision happens in `tick`, so the whole policy —
 * band cadence, settle, ceiling, extraction cadence — is testable without
 * waiting in real time, and the tests can assert the bounds the spec states
 * rather than approximate them.
 */
import type { StandDownReason } from "../db/supervision.js";
import type { DaemonConfig, DaemonSource } from "./config.js";
import type { ScanStats, SourceIndex } from "./scan.js";

export interface StepOutcome {
  ok: boolean;
  /** Counters as the underlying import reported them. */
  filesScanned?: number;
  processed?: number;
  skipped?: number;
  failed?: number;
  error?: string;
}

export interface DaemonPorts {
  /** Import one source: mirror it if needed, then normalize it. */
  runImport(source: DaemonSource, sinceWindow: string): Promise<StepOutcome>;
  /** Derive fact tables across every source. */
  runExtract(): Promise<StepOutcome>;
  /** Record that the daemon is alive and making progress. */
  heartbeat(at: number): Promise<void>;
  onEvent(event: DaemonEvent): void;
}

export type DaemonEvent =
  | {
      kind: "started";
      sources: string[];
      indexedFiles: number;
      indexedDirs: number;
      durationMs: number;
    }
  | {
      kind: "scanned";
      band: string;
      statted: number;
      changed: number;
      durationMs: number;
    }
  | {
      kind: "dirs-scanned";
      statted: number;
      changed: number;
      durationMs: number;
    }
  | {
      kind: "importing";
      source: string;
      reason: "settled" | "ceiling";
      pendingMs: number;
    }
  | {
      kind: "imported";
      source: string;
      durationMs: number;
      /** Age of the oldest unserviced change when it landed. */
      latencyMs: number;
      filesScanned: number | undefined;
      processed: number | undefined;
      skipped: number | undefined;
      failed: number | undefined;
    }
  | { kind: "extracted"; durationMs: number; reason: "settled" | "ceiling" }
  | { kind: "stood-down"; reason: StandDownReason; message: string }
  | { kind: "error"; source: string | undefined; message: string };

export class IngestDaemon {
  /** Last time each band was scanned. */
  private readonly lastBandScan = new Map<string, number>();
  private lastDirScan = 0;
  private busy = false;
  private extractPendingSince: number | undefined;
  private lastImportAt: number | undefined;
  private lastHeartbeatAt = 0;

  constructor(
    private readonly sources: DaemonSource[],
    private readonly index: SourceIndex,
    private readonly config: DaemonConfig,
    private readonly ports: DaemonPorts,
  ) {}

  /**
   * Seed the index without importing.
   *
   * Everything already on disk is recorded as known, so the first cycle does
   * not mistake an existing corpus for a corpus that just changed. The walk is
   * the one-time startup cost the spec states separately from the steady-state
   * budget.
   */
  async start(now: number): Promise<void> {
    // Wall time, not the injected logical clock: `now` drives scheduling
    // decisions, while durations report how long real work actually took.
    const started = Date.now();
    await this.index.fullWalk(now, true);
    for (const band of this.config.bands) this.lastBandScan.set(band.name, now);
    this.lastDirScan = now;
    this.ports.onEvent({
      kind: "started",
      sources: this.sources.map((s) => s.name),
      indexedFiles: this.index.size,
      indexedDirs: this.index.dirCount,
      durationMs: Date.now() - started,
    });
  }

  /**
   * One cycle: scan whatever is due, then import whatever is ready.
   *
   * Scanning and importing never overlap. The import is a child process holding
   * the corpus write lock, and a scan that ran alongside it would only queue
   * work the running import is about to cover.
   */
  async tick(now: number): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.runDueScans(now);
      await this.runDueImports(now);
      await this.runDueExtract(now);
      // Throttled: the heartbeat is a corpus write, and one per cycle would
      // put a steady write stream through a database meant to be read.
      if (now - this.lastHeartbeatAt >= this.config.heartbeatIntervalMs) {
        this.lastHeartbeatAt = now;
        await this.ports.heartbeat(now);
      }
    } finally {
      this.busy = false;
    }
  }

  private async runDueScans(now: number): Promise<void> {
    let lowerAgeMs = 0;
    for (const band of this.config.bands) {
      const last = this.lastBandScan.get(band.name) ?? 0;
      const due = now - last >= band.intervalMs;
      if (due) {
        const started = Date.now();
        // The catch-all band's scan is the full reconciliation walk: it is the
        // only pass that can discover files the index has never seen.
        const stats: ScanStats =
          band.maxAgeMs === null
            ? await this.index.fullWalk(now)
            : await this.index.scanBand(band, lowerAgeMs, now);
        this.lastBandScan.set(band.name, now);
        this.ports.onEvent({
          kind: "scanned",
          band: band.name,
          statted: stats.statted,
          changed: stats.changed,
          durationMs: Date.now() - started,
        });
      }
      if (band.maxAgeMs !== null) lowerAgeMs = band.maxAgeMs;
    }

    if (now - this.lastDirScan >= this.config.dirIntervalMs) {
      const started = Date.now();
      const stats = await this.index.scanDirs(now);
      this.lastDirScan = now;
      this.ports.onEvent({
        kind: "dirs-scanned",
        statted: stats.statted,
        changed: stats.changed,
        durationMs: Date.now() - started,
      });
    }
  }

  private async runDueImports(now: number): Promise<void> {
    for (const pending of this.index.pendingSources()) {
      const source = this.sources.find((s) => s.name === pending.source);
      if (source === undefined) {
        this.index.clearPending(pending.source);
        continue;
      }
      // Settled means no NEW change for the quiet period; the ceiling counts
      // from the first unserviced change. Measuring both from the same instant
      // would make a source that never stops being written look settled as soon
      // as the quiet period elapsed once — the starvation the ceiling exists to
      // prevent.
      const quietFor = now - pending.lastChangeAt;
      const waited = now - pending.since;
      const settled = quietFor >= this.config.settleMs;
      const ceiling = waited >= this.config.ceilingMs;
      if (!settled && !ceiling) continue;

      this.ports.onEvent({
        kind: "importing",
        source: source.name,
        reason: ceiling && !settled ? "ceiling" : "settled",
        pendingMs: waited,
      });
      this.index.clearPending(source.name);

      const started = Date.now();
      const outcome = await this.ports.runImport(
        source,
        this.config.sinceWindow,
      );
      const finished = Date.now();
      if (!outcome.ok) {
        this.ports.onEvent({
          kind: "error",
          source: source.name,
          message: outcome.error ?? "import failed",
        });
        continue;
      }
      this.ports.onEvent({
        kind: "imported",
        source: source.name,
        durationMs: finished - started,
        latencyMs: now - pending.since + (finished - started),
        filesScanned: outcome.filesScanned,
        processed: outcome.processed,
        skipped: outcome.skipped,
        failed: outcome.failed,
      });
      this.lastImportAt = now;
      if (this.extractPendingSince === undefined)
        this.extractPendingSince = now;
    }
  }

  private async runDueExtract(now: number): Promise<void> {
    if (this.config.noExtract) return;
    const pendingSince = this.extractPendingSince;
    if (pendingSince === undefined) return;

    const quiet =
      this.lastImportAt !== undefined &&
      now - this.lastImportAt >= this.config.extractSettleMs;
    const ceiling = now - pendingSince >= this.config.extractCeilingMs;
    if (!quiet && !ceiling) return;

    this.extractPendingSince = undefined;
    const started = Date.now();
    const outcome = await this.ports.runExtract();
    if (!outcome.ok) {
      this.ports.onEvent({
        kind: "error",
        source: undefined,
        message: outcome.error ?? "extract failed",
      });
      return;
    }
    this.ports.onEvent({
      kind: "extracted",
      durationMs: Date.now() - started,
      reason: ceiling && !quiet ? "ceiling" : "settled",
    });
  }
}
