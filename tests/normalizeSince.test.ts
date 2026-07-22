import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  combinedFreshnessStat,
  filterFilesBySince,
  listClineMetadataSibling,
} from "../src/commands/normalize.js";

describe("filterFilesBySince", () => {
  let dir: string;
  const nowSec = Math.floor(Date.now() / 1000);

  function writeWithMtime(name: string, ageSec: number): string {
    const full = join(dir, name);
    writeFileSync(full, "x");
    const mtime = nowSec - ageSec;
    utimesSync(full, mtime, mtime);
    return full;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentmine-since-test-"));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("keeps files newer than the cutoff and drops older ones", async () => {
    const recent = writeWithMtime("recent.jsonl", 3600); // 1h ago
    writeWithMtime("stale.jsonl", 3 * 86400); // 3d ago

    const cutoff = nowSec - 86400; // 1d window
    const kept = await filterFilesBySince(
      [recent, join(dir, "stale.jsonl")],
      cutoff,
    );

    expect(kept).toEqual([recent]);
  });

  it("keeps a file whose mtime equals the cutoff (inclusive boundary)", async () => {
    const exact = writeWithMtime("exact.jsonl", 86400);
    const cutoff = nowSec - 86400;

    const kept = await filterFilesBySince([exact], cutoff);

    expect(kept).toEqual([exact]);
  });

  it("keeps entries that cannot be stat'd (e.g. opencode-db session IDs)", async () => {
    const real = writeWithMtime("real.jsonl", 3600);
    const cutoff = nowSec - 86400;

    // 'ses_abc123' is not a filesystem path — stat throws, so it is preserved.
    const kept = await filterFilesBySince(["ses_abc123", real], cutoff);

    expect(kept).toEqual(["ses_abc123", real]);
  });

  it("keeps stale Cline root messages when root metadata is fresh", async () => {
    const messages = writeWithMtime("fixture-001.messages.json", 3 * 86400);
    writeWithMtime("fixture-001.json", 3600);
    const cutoff = nowSec - 86400;

    const kept = await filterFilesBySince(
      [messages],
      cutoff,
      listClineMetadataSibling,
    );

    expect(kept).toEqual([messages]);
  });
});

describe("combinedFreshnessStat", () => {
  let dir: string;
  const nowSec = Math.floor(Date.now() / 1000);

  function writeWithMtime(name: string, ageSec: number, body = "x"): string {
    const full = join(dir, name);
    writeFileSync(full, body);
    const mtime = nowSec - ageSec;
    utimesSync(full, mtime, mtime);
    return full;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentmine-freshstat-"));
  });
  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("returns the primary file's mtime and size when it has no siblings", async () => {
    const file = writeWithMtime("a.jsonl", 3600, "hello");
    const st = await combinedFreshnessStat(file);
    expect(st).toEqual({ mtimeMs: expect.any(Number), size: 5 });
  });

  it("folds in a fresher sibling so a sibling-only change invalidates the entry", async () => {
    const messages = writeWithMtime("s.messages.json", 3 * 86400, "abc");
    writeWithMtime("s.json", 3 * 86400, "meta");
    const before = await combinedFreshnessStat(
      messages,
      listClineMetadataSibling,
    );

    // Touch only the metadata sibling with a fresh mtime + different size.
    const fresh = nowSec;
    writeFileSync(join(dir, "s.json"), "metadata-updated");
    utimesSync(join(dir, "s.json"), fresh, fresh);

    const after = await combinedFreshnessStat(
      messages,
      listClineMetadataSibling,
    );
    expect(after).not.toEqual(before);
    expect(after?.mtimeMs).toBeGreaterThan(before?.mtimeMs ?? 0);
    // size = messages(3) + metadata(16)
    expect(after?.size).toBe(3 + "metadata-updated".length);
  });

  it("returns null when the primary file cannot be stat'd", async () => {
    expect(await combinedFreshnessStat("ses_not_a_path")).toBeNull();
  });
});
