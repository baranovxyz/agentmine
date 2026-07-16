import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
