import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertArtifactSnapshot,
  assertNormalizeAccounting,
  assertReceiptDoesNotContainPaths,
  assertWorkDirOutsideRepositories,
  buildAbbaSchedule,
  createSignalHandler,
  discoverRepositoryRoots,
  listClaudeRootJsonl,
  parseGnuTime,
  pathIsWithin,
  sanitizeErrorMessage,
  selectStratifiedFiles,
  snapshotArtifact,
  stageFixture,
  verifyStagedFixture,
} from "../scripts/cold-import-benchmark.mjs";

interface Candidate {
  absolutePath: string;
  relativePath: string;
  size: number;
  identity: string;
}

const temporaryRoots: string[] = [];
const benchmarkScript = fileURLToPath(
  new URL("../scripts/cold-import-benchmark.mjs", import.meta.url),
);
const agentmineRoot = fileURLToPath(new URL("../", import.meta.url));

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function candidates(count: number): Candidate[] {
  return Array.from({ length: count }, (_, index) => ({
    absolutePath: `/private/archive/${String(index).padStart(4, "0")}.jsonl`,
    relativePath: `project/${String(index).padStart(4, "0")}.jsonl`,
    size: (index + 1) * 1_024,
    identity: `1:${index + 1}`,
  }));
}

describe("cold-import benchmark harness", () => {
  it("builds serial ABBA blocks for both A-runtime choices", () => {
    expect(buildAbbaSchedule(2, "node").map((slot) => slot.runtime)).toEqual([
      "node",
      "bun",
      "bun",
      "node",
      "node",
      "bun",
      "bun",
      "node",
    ]);
    expect(buildAbbaSchedule(1, "bun").map((slot) => slot.runtime)).toEqual([
      "bun",
      "node",
      "node",
      "bun",
    ]);
  });

  it("selects a deterministic unique fixture near the byte target", () => {
    const input = candidates(2_000);
    const duplicate = input[1000];
    if (duplicate === undefined) throw new Error("missing fixture candidate");
    input.push({ ...duplicate, relativePath: "duplicate.jsonl" });
    const options = {
      selectedFiles: 1_000,
      targetBytes: 1_000 * 1_024 * 1_024,
    };
    const first = selectStratifiedFiles(input, options);
    const second = selectStratifiedFiles([...input].reverse(), options);

    expect(first.files).toHaveLength(1_000);
    expect(new Set(first.files.map((file) => file.identity))).toHaveLength(
      1_000,
    );
    expect(first.files.map((file) => file.identity)).toEqual(
      second.files.map((file) => file.identity),
    );
    expect(first.targetDeltaRatio).toBeLessThanOrEqual(0.05);
    expect(first.strata).toHaveLength(10);
    expect(first.strata.every((stratum) => stratum.selected_files > 0)).toBe(
      true,
    );
  });

  it("rejects an undersized unique archive", () => {
    expect(() =>
      selectStratifiedFiles(candidates(999), {
        selectedFiles: 1_000,
        targetBytes: 512 * 1024 * 1024,
      }),
    ).toThrow("999 unique nonempty JSONL files");
  });

  it("freezes root sessions at the cutoff and excludes nested subagents", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmine-cold-scan-"));
    temporaryRoots.push(root);
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    const nested = join(projectA, "session", "subagents");
    mkdirSync(projectA);
    mkdirSync(projectB);
    mkdirSync(nested, { recursive: true });
    const before = new Date("2026-01-01T00:00:00.000Z");
    const after = new Date("2026-03-01T00:00:00.000Z");
    const cutoff = Date.parse("2026-02-01T00:00:00.000Z");
    const keptA = join(projectA, "same-session.jsonl");
    const keptB = join(projectB, "same-session.jsonl");
    const late = join(projectB, "late-session.jsonl");
    const child = join(nested, "agent-child.jsonl");
    for (const file of [keptA, keptB, late, child]) {
      writeFileSync(file, "{}\n");
      utimesSync(file, before, before);
    }
    utimesSync(late, after, after);

    const scanned = await listClaudeRootJsonl(root, cutoff);
    expect(scanned.map((file) => file.relativePath)).toEqual([
      "project-a/same-session.jsonl",
      "project-b/same-session.jsonl",
    ]);
    expect(new Set(scanned.map((file) => file.identity))).toEqual(
      new Set(["same-session"]),
    );
  });

  it("parses GNU time metrics without accepting partial output", () => {
    expect(
      parseGnuTime(
        [
          "wall_seconds=12.34",
          "user_seconds=8.12",
          "system_seconds=1.50",
          "max_rss_kib=2048",
          "exit_status=0",
        ].join("\n"),
      ),
    ).toEqual({
      wallSeconds: 12.34,
      userSeconds: 8.12,
      systemSeconds: 1.5,
      maxRssKib: 2048,
      exitStatus: 0,
    });
    expect(() => parseGnuTime("wall_seconds=1")).toThrow("incomplete");
  });

  it("accounts for skipped empty files without accepting session-id collisions", () => {
    const normalize = {
      processed: 7,
      skipped_empty: 3,
      skipped_up_to_date: 0,
      skipped_unchanged: 0,
      skipped_by_filter: 0,
      failed: 0,
    };

    expect(() =>
      assertNormalizeAccounting(normalize, { sessions: 7 }, 10),
    ).not.toThrow();
    expect(() =>
      assertNormalizeAccounting(normalize, { sessions: 6 }, 10),
    ).toThrow("session-id collisions");
    expect(() =>
      assertNormalizeAccounting(normalize, { sessions: 7 }, 9),
    ).toThrow("session-id collisions");
    expect(() =>
      assertNormalizeAccounting(
        {
          ...normalize,
          processed: 6,
          skipped_up_to_date: 1,
        },
        { sessions: 6 },
        10,
      ),
    ).toThrow("session-id collisions");
  });

  it("recognizes repository descendants and rejects private paths in receipts", () => {
    expect(pathIsWithin("/repo", "/repo/worktree")).toBe(true);
    expect(pathIsWithin("/repo", "/repo")).toBe(true);
    expect(pathIsWithin("/repo", "/repository")).toBe(false);
    expect(() =>
      assertReceiptDoesNotContainPaths(
        { fixture: { archive: "/private/archive/source" } },
        ["/private/archive"],
      ),
    ).toThrow("private absolute path");
    expect(() =>
      assertReceiptDoesNotContainPaths(
        { fixture: { manifest_sha256: "abc" } },
        ["/private/archive"],
      ),
    ).not.toThrow();
  });

  it("rejects work directories inside the main or a sibling Git worktree", () => {
    const roots = ["/repo", "/repo/.claude/worktrees/current"];
    expect(() =>
      assertWorkDirOutsideRepositories("/repo/tmp-benchmark", roots),
    ).toThrow("registered Git worktree");
    expect(() =>
      assertWorkDirOutsideRepositories(
        "/repo/.claude/worktrees/other/cache",
        roots,
      ),
    ).toThrow("registered Git worktree");
    expect(() =>
      assertWorkDirOutsideRepositories("/var/tmp/agentmine-benchmark", roots),
    ).not.toThrow();
  });

  it("discovers repository roots from umbrella and standalone package layouts", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmine-git-layout-"));
    temporaryRoots.push(root);
    const repository = join(root, "agentmine");
    const umbrellaPackage = join(repository, "packages", "agentmine");
    const linkedWorktree = join(root, "agentmine-linked");
    mkdirSync(umbrellaPackage, { recursive: true });
    writeFileSync(join(repository, "README.md"), "fixture\n");
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(result.stderr || "git fixture command failed");
      }
    };
    git(["init", "--quiet", repository]);
    git(["-C", repository, "add", "README.md"]);
    git([
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    git([
      "-C",
      repository,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      linkedWorktree,
    ]);

    const standalone = await discoverRepositoryRoots(repository);
    const umbrella = await discoverRepositoryRoots(umbrellaPackage);
    const expectedRoots = [
      realpathSync(repository),
      realpathSync(linkedWorktree),
    ];
    expect(standalone.currentRoot).toBe(realpathSync(repository));
    expect(new Set(standalone.repositoryRoots)).toEqual(new Set(expectedRoots));
    expect(umbrella.currentRoot).toBe(realpathSync(repository));
    expect(new Set(umbrella.repositoryRoots)).toEqual(new Set(expectedRoots));
  });

  it("pins deterministic artifact trees and detects mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmine-artifact-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "z.js"), "z\n");
    writeFileSync(join(root, "nested", "a.js"), "a\n");

    const first = await snapshotArtifact(root);
    const unchanged = await snapshotArtifact(root);
    expect(unchanged.sha256).toBe(first.sha256);
    expect(() =>
      assertArtifactSnapshot(first, unchanged, "node"),
    ).not.toThrow();

    writeFileSync(join(root, "nested", "a.js"), "changed\n");
    const changed = await snapshotArtifact(root);
    expect(() => assertArtifactSnapshot(first, changed, "node")).toThrow(
      "artifact changed",
    );
  });

  it("hashes the staged fixture and rejects post-stage mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmine-stage-"));
    temporaryRoots.push(root);
    const archiveProject = join(root, "archive", "project");
    const fixture = join(root, "fixture");
    mkdirSync(archiveProject, { recursive: true });
    mkdirSync(fixture);
    const source = join(archiveProject, "session.jsonl");
    const metadata = join(archiveProject, "session.meta.json");
    writeFileSync(source, '{"type":"summary"}\n');
    writeFileSync(metadata, '{"agentType":"reviewer"}\n');
    const sourceStat = statSync(source);

    const staged = await stageFixture(
      {
        files: [
          {
            absolutePath: source,
            relativePath: "project/session.jsonl",
            size: sourceStat.size,
            mtimeMs: sourceStat.mtimeMs,
            ctimeMs: sourceStat.ctimeMs,
            ino: sourceStat.ino,
            dev: sourceStat.dev,
            identity: "session",
          },
        ],
      },
      fixture,
      "copy",
      1,
    );
    expect(staged.supplementalFiles).toBe(1);
    expect(staged.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(staged.treeManifestSha256).toMatch(/^[0-9a-f]{64}$/u);

    writeFileSync(source, "source changed after snapshot\n");
    await expect(verifyStagedFixture(staged)).resolves.toBeUndefined();

    const stagedSource = join(
      fixture,
      "xdg",
      "agentmine",
      "sessions",
      "claude-code",
      "project",
      "session.jsonl",
    );
    writeFileSync(stagedSource, "staged mutation\n");
    await expect(verifyStagedFixture(staged)).rejects.toThrow(
      "staged fixture changed",
    );
  });

  it("hardlinks and revalidates JSONL and metadata without rejecting ctime changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmine-hardlink-stage-"));
    temporaryRoots.push(root);
    const archiveProject = join(root, "archive", "project");
    const fixture = join(root, "fixture");
    mkdirSync(archiveProject, { recursive: true });
    mkdirSync(fixture);
    const source = join(archiveProject, "session.jsonl");
    const metadata = join(archiveProject, "session.meta.json");
    writeFileSync(source, '{"type":"summary"}\n');
    writeFileSync(metadata, '{"agentType":"reviewer"}\n');
    const sourceStat = statSync(source);

    const staged = await stageFixture(
      {
        files: [
          {
            absolutePath: source,
            relativePath: "project/session.jsonl",
            size: sourceStat.size,
            mtimeMs: sourceStat.mtimeMs,
            ctimeMs: sourceStat.ctimeMs,
            ino: sourceStat.ino,
            dev: sourceStat.dev,
            identity: "session",
          },
        ],
      },
      fixture,
      "hardlink",
      1,
    );
    const stagedRoot = join(
      fixture,
      "xdg",
      "agentmine",
      "sessions",
      "claude-code",
      "project",
    );
    expect(statSync(join(stagedRoot, "session.jsonl")).ino).toBe(
      statSync(source).ino,
    );
    expect(statSync(join(stagedRoot, "session.meta.json")).ino).toBe(
      statSync(metadata).ino,
    );
    await expect(verifyStagedFixture(staged)).resolves.toBeUndefined();

    writeFileSync(source, "source mutation reaches hardlink\n");
    await expect(verifyStagedFixture(staged)).rejects.toThrow(
      "staged fixture changed",
    );
  });

  it("aborts gracefully on the first signal and hard-stops on the second", () => {
    const controller = new AbortController();
    const terminations: string[] = [];
    const hardExits: number[] = [];
    const handleSignal = createSignalHandler(
      controller,
      (signal) => terminations.push(signal),
      (code) => hardExits.push(code),
    );

    handleSignal("SIGINT");
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toMatchObject({
      message: "Benchmark interrupted by SIGINT",
    });
    expect(terminations).toEqual(["SIGTERM"]);
    expect(hardExits).toEqual([]);

    handleSignal("SIGTERM");
    expect(terminations).toEqual(["SIGTERM", "SIGKILL"]);
    expect(hardExits).toEqual([143]);
  });

  it("sanitizes quoted paths with spaces or Unicode components", () => {
    const sanitized = sanitizeErrorMessage(
      "ENOENT '/home/example/My Project/archive' and '/home/пример/archive'",
    );
    expect(sanitized).toBe("ENOENT '<path>' and '<path>'");
  });

  it("keeps the documented pnpm wrapper JSON-clean for invalid arguments", () => {
    const result = spawnSync(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["--silent", "benchmark:cold-import"],
      {
        cwd: agentmineRoot,
        encoding: "utf8",
      },
    );
    const stdoutLines = result.stdout.trim().split("\n");
    expect(stdoutLines).toHaveLength(1);
    const envelope = z
      .object({
        version: z.literal(1),
        status: z.literal("error"),
        errors: z.array(
          z.object({
            code: z.literal(1_000),
            name: z.literal("VALIDATION_ERROR"),
            category: z.literal("user"),
            retryable: z.literal(false),
          }),
        ),
      })
      .parse(JSON.parse(stdoutLines[0] ?? ""));

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(envelope.errors).toHaveLength(1);
  });

  it("emits the same coded invalid-argument envelope when invoked directly", () => {
    const result = spawnSync(process.execPath, [benchmarkScript], {
      encoding: "utf8",
    });
    const envelope = z
      .object({
        version: z.literal(1),
        status: z.literal("error"),
        errors: z.array(
          z.object({
            code: z.literal(1_000),
            name: z.literal("VALIDATION_ERROR"),
            category: z.literal("user"),
            retryable: z.literal(false),
          }),
        ),
      })
      .parse(JSON.parse(result.stdout));

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(envelope.errors).toHaveLength(1);
  });
});
