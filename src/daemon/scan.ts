/**
 * The change detector.
 *
 * A naive detector restats every file on every cycle, so its cost grows with
 * the corpus while the useful work does not — measured at roughly 2% of a core,
 * forever, to notice that nothing changed. This one keeps an in-memory index of
 * known files and rescans them in recency bands, so per-cycle cost tracks recent
 * activity instead of accumulated history.
 *
 * Three moving parts:
 *
 *   band scan  — restat only the index entries whose age puts them in the band
 *                that is due. A file whose modification time advances marks its
 *                source dirty and re-enters the fastest band on the next cycle,
 *                so the partition is self-correcting.
 *   dir scan   — restat known directories; read the ones that changed. This is
 *                what finds a NEWLY created session, which has no history to
 *                place it in a band and may appear in a directory dormant for
 *                months.
 *   full walk  — the catch-all band's own scan. It doubles as reconciliation:
 *                it discovers files the index never saw and drops ones removed.
 *
 * The filesystem is injected so the scheduling can be tested without a real
 * tree, and so a test can prove the scale-invariance requirement by simulating
 * a large frozen history.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Band, DaemonSource } from "./config.js";

export interface ScanFs {
  /** Entries of one directory. Missing or unreadable yields an empty list. */
  readDir(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  /** Modification time in epoch ms, or undefined when unreadable. */
  mtimeMs(path: string): Promise<number | undefined>;
}

export const nodeScanFs: ScanFs = {
  async readDir(path) {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
      }));
    } catch {
      return [];
    }
  },
  async mtimeMs(path) {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
      return undefined;
    }
  },
};

interface IndexedFile {
  mtimeMs: number;
  source: string;
}

export interface DirtyState {
  /** When this source first went dirty; drives the ceiling. */
  since: number;
  /** When this source last changed; drives the quiet period. */
  lastChangeAt: number;
}

export interface ScanStats {
  /** Files whose modification time was read this cycle. */
  statted: number;
  /** Files whose modification time advanced. */
  changed: number;
}

export class SourceIndex {
  private readonly files = new Map<string, IndexedFile>();
  private readonly dirs = new Map<string, number>();
  /**
   * Band membership, so a band scan iterates only its own members.
   *
   * Selecting members by filtering the whole index would make each cycle O(all
   * files) even when the band holds a handful — the cost growing with frozen
   * history is exactly what banding exists to avoid, and it would creep back in
   * through the selection rather than the stat.
   *
   * Membership is assigned when a file's time is recorded and rebalanced on the
   * full walk. Between walks a file can linger one band too fast as it ages,
   * which only means scanning it more often than needed; it never means missing
   * it, and it self-corrects on the next walk.
   */
  private readonly bandMembers = new Map<string, Set<string>>();
  /**
   * Sources with unserviced changes.
   *
   * Two timestamps, because they answer different questions: `since` is when
   * the source first went dirty and drives the ceiling, while `lastChangeAt`
   * is when it last changed and drives the quiet period. Collapsing them makes
   * a continuously-written source look settled the moment the quiet period
   * elapses from its FIRST change, which is exactly the starvation the ceiling
   * exists to prevent.
   */
  private readonly dirty = new Map<string, DirtyState>();

  constructor(
    private readonly sources: DaemonSource[],
    private readonly fs: ScanFs,
    private readonly bands: Band[] = [],
  ) {
    for (const band of bands) this.bandMembers.set(band.name, new Set());
  }

  /** Which band a file of this age belongs to. Bands are ordered fastest first. */
  private bandFor(ageMs: number): string | undefined {
    for (const band of this.bands) {
      if (band.maxAgeMs === null || ageMs < band.maxAgeMs) return band.name;
    }
    return this.bands.at(-1)?.name;
  }

  private place(path: string, mtimeMs: number, now: number): void {
    const target = this.bandFor(Math.max(0, now - mtimeMs));
    for (const [name, members] of this.bandMembers) {
      if (name === target) members.add(path);
      else members.delete(path);
    }
  }

  private unplace(path: string): void {
    for (const members of this.bandMembers.values()) members.delete(path);
  }

  get size(): number {
    return this.files.size;
  }

  get dirCount(): number {
    return this.dirs.size;
  }

  /** Sources with unserviced changes, oldest first. */
  pendingSources(): Array<{ source: string } & DirtyState> {
    return [...this.dirty.entries()]
      .map(([source, state]) => ({ source, ...state }))
      .sort((a, b) => a.since - b.since);
  }

  clearPending(source: string): void {
    this.dirty.delete(source);
  }

  private markDirty(source: string, now: number): void {
    const existing = this.dirty.get(source);
    this.dirty.set(source, {
      since: existing?.since ?? now,
      lastChangeAt: now,
    });
  }

  /**
   * Full reconciliation walk. Discovers unknown files, drops removed ones, and
   * refreshes every modification time.
   *
   * `seedOnly` records what exists WITHOUT marking anything dirty. Startup uses
   * it so a daemon does not import the entire corpus the first time it runs
   * merely because it has never seen those files before.
   */
  async fullWalk(now: number, seedOnly = false): Promise<ScanStats> {
    const stats: ScanStats = { statted: 0, changed: 0 };
    const seen = new Set<string>();
    // The walk is also the rebalance: every surviving file is re-placed from
    // its current age, so files that aged out of a fast band leave it.
    for (const members of this.bandMembers.values()) members.clear();

    for (const source of this.sources) {
      const roots = [scanRootOf(source)];
      while (roots.length > 0) {
        const dir = roots.pop();
        if (dir === undefined) continue;
        const dirMtime = await this.fs.mtimeMs(dir);
        if (dirMtime !== undefined) this.dirs.set(dir, dirMtime);

        for (const entry of await this.fs.readDir(dir)) {
          const path = join(dir, entry.name);
          if (entry.isDirectory) {
            roots.push(path);
            continue;
          }
          seen.add(path);
          stats.statted += 1;
          const mtime = await this.fs.mtimeMs(path);
          if (mtime === undefined) continue;
          const known = this.files.get(path);
          this.files.set(path, { mtimeMs: mtime, source: source.name });
          this.place(path, mtime, now);
          if (seedOnly) continue;
          // An unknown file is a change: it is a session that did not exist
          // the last time this source was reconciled.
          if (known === undefined || mtime > known.mtimeMs) {
            stats.changed += 1;
            this.markDirty(source.name, now);
          }
        }
      }
    }

    for (const path of [...this.files.keys()]) {
      if (seen.has(path)) continue;
      this.files.delete(path);
      this.unplace(path);
    }
    return stats;
  }

  /**
   * Restat only the entries whose age places them in `band`, using the age
   * boundary of the previous band as the lower edge.
   */
  async scanBand(
    band: Band,
    _lowerAgeMs: number,
    now: number,
  ): Promise<ScanStats> {
    const stats: ScanStats = { statted: 0, changed: 0 };
    const members = this.bandMembers.get(band.name);
    if (members === undefined) return stats;

    for (const path of [...members]) {
      const known = this.files.get(path);
      if (known === undefined) {
        members.delete(path);
        continue;
      }
      stats.statted += 1;
      const mtime = await this.fs.mtimeMs(path);
      if (mtime === undefined) {
        this.files.delete(path);
        this.unplace(path);
        continue;
      }
      if (mtime > known.mtimeMs) {
        this.files.set(path, { mtimeMs: mtime, source: known.source });
        // A written file is recent again, so it belongs in the fastest band
        // from now on — this is what makes the partition self-correcting.
        this.place(path, mtime, now);
        stats.changed += 1;
        this.markDirty(known.source, now);
      }
    }
    return stats;
  }

  /**
   * Restat known directories and read the ones whose modification time moved.
   *
   * This is the only path that finds a session created in a location the index
   * has nothing recent for. A file's own modification time cannot reveal it,
   * because the file did not exist to be indexed.
   */
  async scanDirs(now: number): Promise<ScanStats> {
    const stats: ScanStats = { statted: 0, changed: 0 };
    const bySource = new Map<string, string>();
    for (const source of this.sources)
      bySource.set(scanRootOf(source), source.name);

    for (const [dir, knownMtime] of [...this.dirs]) {
      stats.statted += 1;
      const mtime = await this.fs.mtimeMs(dir);
      if (mtime === undefined) {
        this.dirs.delete(dir);
        continue;
      }
      if (mtime <= knownMtime) continue;
      this.dirs.set(dir, mtime);

      const source = this.sourceForPath(dir);
      if (source === undefined) continue;
      for (const entry of await this.fs.readDir(dir)) {
        const path = join(dir, entry.name);
        if (entry.isDirectory) {
          if (!this.dirs.has(path)) {
            const sub = await this.fs.mtimeMs(path);
            if (sub !== undefined) this.dirs.set(path, sub);
          }
          continue;
        }
        if (this.files.has(path)) continue;
        const fileMtime = await this.fs.mtimeMs(path);
        if (fileMtime === undefined) continue;
        this.files.set(path, { mtimeMs: fileMtime, source });
        this.place(path, fileMtime, now);
        stats.changed += 1;
        this.markDirty(source, now);
      }
    }
    return stats;
  }

  /** Which source owns a path, by longest matching scan root. */
  private sourceForPath(path: string): string | undefined {
    let best: { name: string; length: number } | undefined;
    for (const source of this.sources) {
      const root = scanRootOf(source);
      if (
        path !== root &&
        !path.startsWith(root.endsWith("/") ? root : `${root}/`)
      ) {
        continue;
      }
      if (best === undefined || root.length > best.length) {
        best = { name: source.name, length: root.length };
      }
    }
    return best?.name;
  }
}

function scanRootOf(source: DaemonSource): string {
  return source.kind === "db" ? dirOf(source.path) : source.path;
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? path : path.slice(0, index);
}
