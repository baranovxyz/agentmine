import { describe, expect, it, vi } from "vitest";
import {
  type Band,
  type DaemonConfig,
  type DaemonSource,
  DEFAULT_CONFIG,
} from "../src/daemon/config.js";
import {
  type DaemonEvent,
  IngestDaemon,
  type StepOutcome,
} from "../src/daemon/daemon.js";
import { type ScanFs, SourceIndex } from "../src/daemon/scan.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const SOURCE: DaemonSource = {
  name: "claude-code",
  corpusName: "claude-code",
  kind: "mirror",
  path: "/root",
};

/** An in-memory tree so scheduling is testable without touching a disk. */
class FakeFs implements ScanFs {
  readonly files = new Map<string, number>();
  readonly dirs = new Map<string, number>();
  statCalls = 0;

  constructor(dirs: string[] = ["/root"]) {
    for (const d of dirs) this.dirs.set(d, 0);
  }

  addFile(path: string, mtimeMs: number): void {
    this.files.set(path, mtimeMs);
    const dir = path.slice(0, path.lastIndexOf("/"));
    this.dirs.set(dir, mtimeMs);
  }

  touch(path: string, mtimeMs: number): void {
    this.files.set(path, mtimeMs);
  }

  async readDir(path: string) {
    const out: Array<{ name: string; isDirectory: boolean }> = [];
    for (const dir of this.dirs.keys()) {
      if (
        dir !== path &&
        dir.startsWith(`${path}/`) &&
        !dir.slice(path.length + 1).includes("/")
      ) {
        out.push({ name: dir.slice(path.length + 1), isDirectory: true });
      }
    }
    for (const file of this.files.keys()) {
      if (
        file.startsWith(`${path}/`) &&
        !file.slice(path.length + 1).includes("/")
      ) {
        out.push({ name: file.slice(path.length + 1), isDirectory: false });
      }
    }
    return out;
  }

  async mtimeMs(path: string) {
    this.statCalls += 1;
    return this.files.get(path) ?? this.dirs.get(path);
  }
}

interface Harness {
  daemon: IngestDaemon;
  fs: FakeFs;
  events: DaemonEvent[];
  imports: string[];
  sinceWindows: Array<string | undefined>;
  extracts: number;
}

type ImportOutcome = StepOutcome | (() => StepOutcome | Promise<StepOutcome>);

function harness(
  overrides: Partial<DaemonConfig> = {},
  outcome: ImportOutcome = { ok: true, processed: 1 },
  fs: FakeFs = new FakeFs(),
  extractOutcome: StepOutcome = { ok: true },
): Harness {
  const config: DaemonConfig = { ...DEFAULT_CONFIG, ...overrides };
  const events: DaemonEvent[] = [];
  const imports: string[] = [];
  const sinceWindows: Array<string | undefined> = [];
  let extracts = 0;
  const index = new SourceIndex([SOURCE], fs, config.bands);
  const daemon = new IngestDaemon([SOURCE], index, config, {
    runImport: async (source, sinceWindow) => {
      imports.push(source.name);
      sinceWindows.push(sinceWindow);
      return typeof outcome === "function" ? await outcome() : outcome;
    },
    runExtract: async () => {
      extracts += 1;
      return extractOutcome;
    },
    heartbeat: async () => {},
    onEvent: (e) => events.push(e),
  });
  return {
    daemon,
    fs,
    events,
    imports,
    sinceWindows,
    get extracts() {
      return extracts;
    },
  } as Harness;
}

describe("daemon scheduling", () => {
  it("reconciles an existing corpus once after startup", async () => {
    const fs = new FakeFs();
    fs.addFile("/root/a.jsonl", 1_000);
    const h = harness({}, { ok: true }, fs);

    await h.daemon.start(10_000);
    await h.daemon.tick(20_000);

    expect(h.imports).toEqual(["claude-code"]);
    expect(h.sinceWindows).toEqual([undefined]);
  });

  it("imports a settled change once the quiet period passes", async () => {
    const fs = new FakeFs();
    fs.addFile("/root/a.jsonl", 1_000);
    const h = harness({ settleMs: 2_000, ceilingMs: 20_000 }, { ok: true }, fs);
    await h.daemon.start(10_000);

    fs.touch("/root/a.jsonl", 12_000);
    await h.daemon.tick(12_100);
    expect(h.imports).toEqual([]); // detected, not yet settled

    await h.daemon.tick(14_200);
    expect(h.imports).toEqual(["claude-code"]);
  });

  it("imports a continuously-written source on the ceiling rather than starving", async () => {
    const fs = new FakeFs();
    fs.addFile("/root/a.jsonl", 1_000);
    const h = harness({ settleMs: 5_000, ceilingMs: 10_000 }, { ok: true }, fs);
    await h.daemon.start(10_000);

    // A write on every tick means the quiet period never elapses.
    let now = 11_000;
    for (let i = 0; i < 12; i += 1) {
      fs.touch("/root/a.jsonl", now);
      await h.daemon.tick(now);
      now += 1_000;
    }

    expect(h.imports.length).toBeGreaterThan(0);
    const reasons = h.events
      .filter(
        (e): e is Extract<DaemonEvent, { kind: "importing" }> =>
          e.kind === "importing",
      )
      .map((e) => e.reason);
    expect(reasons).toContain("ceiling");
  });

  it("reports the counters the import actually returned, not zeroes", async () => {
    const fs = new FakeFs();
    fs.addFile("/root/a.jsonl", 1_000);
    const h = harness(
      { settleMs: 0 },
      { ok: true, filesScanned: 3, processed: 2, skipped: 1, failed: 0 },
      fs,
    );
    await h.daemon.start(10_000);

    fs.touch("/root/a.jsonl", 12_000);
    await h.daemon.tick(12_100);

    const imported = h.events.find(
      (e): e is Extract<DaemonEvent, { kind: "imported" }> =>
        e.kind === "imported",
    );
    expect(imported?.processed).toBe(2);
    expect(imported?.filesScanned).toBe(3);
    expect(imported?.skipped).toBe(1);
  });

  it("surfaces a failed import without stopping", async () => {
    const fs = new FakeFs();
    fs.addFile("/root/a.jsonl", 1_000);
    const outcome: StepOutcome = { ok: false, error: "boom" };
    const h = harness({ settleMs: 0 }, outcome, fs);
    await h.daemon.start(10_000);

    fs.touch("/root/a.jsonl", 12_000);
    await h.daemon.tick(12_100);

    expect(h.events.some((e) => e.kind === "error")).toBe(true);
    expect(h.events.some((e) => e.kind === "imported")).toBe(false);

    outcome.ok = true;
    delete outcome.error;
    await h.daemon.tick(17_099);
    expect(h.imports).toEqual(["claude-code"]);

    await h.daemon.tick(17_200);
    expect(h.imports).toEqual(["claude-code", "claude-code"]);
    expect(h.events.some((e) => e.kind === "imported")).toBe(true);
  });

  it("reconciles unchanged bytes after a failed daemon is restarted", async () => {
    const fs = new FakeFs();
    fs.addFile("/root/a.jsonl", 1_000);
    const failed = harness(
      { settleMs: 0 },
      { ok: false, error: "interrupted" },
      fs,
    );
    await failed.daemon.start(10_000);
    await failed.daemon.tick(10_000);
    expect(failed.imports).toEqual(["claude-code"]);

    const restarted = harness({ settleMs: 0 }, { ok: true }, fs);
    await restarted.daemon.start(20_000);
    await restarted.daemon.tick(20_000);

    expect(restarted.imports).toEqual(["claude-code"]);
    // Startup deliberately omits the ordinary recency window. Persistent
    // stat-cache entries, not age, decide whether an existing file is done.
    expect(restarted.sinceWindows).toEqual([undefined]);
  });

  it("backs off from failure completion rather than attempt start", async () => {
    const fs = new FakeFs();
    fs.addFile("/root/a.jsonl", 1_000);
    let wallNow = 1_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
    try {
      const h = harness(
        { settleMs: 0 },
        () => {
          wallNow += 6_000;
          return { ok: false, error: "slow failure" };
        },
        fs,
      );
      await h.daemon.start(10_000);
      await h.daemon.tick(10_000);

      await h.daemon.tick(20_999);
      expect(h.imports).toEqual(["claude-code"]);

      await h.daemon.tick(21_000);
      expect(h.imports).toEqual(["claude-code", "claude-code"]);
    } finally {
      now.mockRestore();
    }
  });

  it("drains a cancelled import without starting more work or reporting a fault", async () => {
    const fs = new FakeFs();
    fs.addFile("/root/a.jsonl", 1_000);
    let finish: ((outcome: StepOutcome) => void) | undefined;
    const h = harness(
      { settleMs: 0 },
      () =>
        new Promise<StepOutcome>((resolve) => {
          finish = resolve;
        }),
      fs,
    );
    await h.daemon.start(10_000);

    const ticking = h.daemon.tick(10_000);
    await Promise.resolve();
    expect(finish).toBeDefined();
    h.daemon.stop();
    finish?.({ ok: false, cancelled: true });
    await ticking;
    await h.daemon.tick(20_000);

    expect(h.imports).toEqual(["claude-code"]);
    expect(h.extracts).toBe(0);
    expect(h.events.some((event) => event.kind === "error")).toBe(false);
  });

  it("retains a failed extraction and retries it with backoff", async () => {
    const fs = new FakeFs();
    fs.addFile("/root/a.jsonl", 1_000);
    const extractOutcome: StepOutcome = { ok: false, error: "extract boom" };
    const h = harness(
      { settleMs: 0, extractSettleMs: 1, extractCeilingMs: 60_000 },
      { ok: true },
      fs,
      extractOutcome,
    );
    await h.daemon.start(10_000);
    await h.daemon.tick(10_000);
    await h.daemon.tick(10_002);
    expect(h.extracts).toBe(1);

    extractOutcome.ok = true;
    delete extractOutcome.error;
    await h.daemon.tick(15_001);
    expect(h.extracts).toBe(1);

    await h.daemon.tick(15_200);
    expect(h.extracts).toBe(2);
    expect(h.events.some((event) => event.kind === "extracted")).toBe(true);
  });

  it("extracts on its ceiling even while imports keep arriving", async () => {
    const fs = new FakeFs();
    fs.addFile("/root/a.jsonl", 1_000);
    const h = harness(
      { settleMs: 0, extractSettleMs: 60_000, extractCeilingMs: 5_000 },
      { ok: true, processed: 1 },
      fs,
    );
    await h.daemon.start(10_000);

    let now = 11_000;
    for (let i = 0; i < 10; i += 1) {
      fs.touch("/root/a.jsonl", now);
      await h.daemon.tick(now);
      now += 1_000;
    }

    // The quiet period never elapses, so only the ceiling can have fired.
    const extracted = h.events.filter((e) => e.kind === "extracted");
    expect(extracted.length).toBeGreaterThan(0);
    expect(
      extracted.every((e) => e.kind === "extracted" && e.reason === "ceiling"),
    ).toBe(true);
  });

  it("never extracts when extraction is disabled", async () => {
    const fs = new FakeFs();
    fs.addFile("/root/a.jsonl", 1_000);
    const h = harness(
      { settleMs: 0, noExtract: true, extractCeilingMs: 1 },
      { ok: true },
      fs,
    );
    await h.daemon.start(10_000);

    fs.touch("/root/a.jsonl", 12_000);
    await h.daemon.tick(12_100);
    await h.daemon.tick(20_000);

    expect(h.events.some((e) => e.kind === "extracted")).toBe(false);
  });
});

describe("recency bands", () => {
  const bands: Band[] = [
    { name: "hot", maxAgeMs: DAY, intervalMs: 2_000 },
    { name: "cool", maxAgeMs: 7 * DAY, intervalMs: 5 * MINUTE },
    { name: "cold", maxAgeMs: null, intervalMs: HOUR },
  ];

  it("costs the same per cycle as frozen history grows", async () => {
    const now = 100 * DAY;
    const measure = async (frozenCount: number): Promise<number> => {
      const fs = new FakeFs();
      fs.addFile("/root/live.jsonl", now - MINUTE);
      for (let i = 0; i < frozenCount; i += 1) {
        fs.addFile(`/root/frozen-${i}.jsonl`, now - 30 * DAY);
      }
      const h = harness(
        { bands, settleMs: 0, dirIntervalMs: HOUR },
        { ok: true },
        fs,
      );
      await h.daemon.start(now);
      fs.statCalls = 0;
      // Only the hot band is due; the cool and cold bands are not.
      await h.daemon.tick(now + 2_100);
      return fs.statCalls;
    };

    const small = await measure(10);
    const large = await measure(1_000);

    // 100x the frozen history must not cost meaningfully more per cycle.
    expect(large).toBeLessThanOrEqual(small + 5);
  });

  it("detects a change to a long-dormant file, then tracks it at the fast cadence", async () => {
    const now = 100 * DAY;
    const fs = new FakeFs();
    fs.addFile("/root/ancient.jsonl", now - 40 * DAY);
    const h = harness(
      { bands, settleMs: 0, dirIntervalMs: HOUR },
      { ok: true },
      fs,
    );
    await h.daemon.start(now);
    await h.daemon.tick(now);
    h.imports.length = 0;

    // A resumed session appends to a file that looked finished.
    fs.touch("/root/ancient.jsonl", now + 10);

    // The hot band cannot see it: by age it still belongs to the cold band.
    await h.daemon.tick(now + 2_100);
    expect(h.imports).toEqual([]);

    // The cold band's own cadence catches it.
    await h.daemon.tick(now + HOUR + 1_000);
    expect(h.imports).toEqual(["claude-code"]);

    // Having been written, it is now hot: the next append is caught fast.
    const later = now + HOUR + 10_000;
    fs.touch("/root/ancient.jsonl", later);
    await h.daemon.tick(later + 2_100);
    expect(h.imports).toEqual(["claude-code", "claude-code"]);
  });

  it("finds a new session in a dormant directory via the directory scan", async () => {
    const now = 100 * DAY;
    const fs = new FakeFs();
    fs.addFile("/root/old/existing.jsonl", now - 40 * DAY);
    const h = harness(
      { bands, settleMs: 0, dirIntervalMs: 60_000 },
      { ok: true },
      fs,
    );
    await h.daemon.start(now);
    await h.daemon.tick(now);
    h.imports.length = 0;

    // A brand-new file has no history to place it in a band; only the
    // directory's own modification time reveals it.
    fs.addFile("/root/old/fresh.jsonl", now + 10);

    await h.daemon.tick(now + 2_100);
    expect(h.imports).toEqual([]);

    await h.daemon.tick(now + 61_000);
    expect(h.imports).toEqual(["claude-code"]);
  });
});
