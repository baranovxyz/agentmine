import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createReleaseManifest,
  packageStandalone,
  TARGETS,
  verifyReleaseManifest,
} from "../scripts/standalone-artifacts.mjs";

const VERSION = "9.8.7";
const BUN_VERSION = "1.3.14";
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ARCHIVE_TEST_TIMEOUT = 20_000;

let dir: string;
let binariesDir: string;
let artifactsDir: string;
let manifest: string;
let checksums: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentmine-artifacts-"));
  binariesDir = join(dir, "binaries");
  artifactsDir = join(dir, "artifacts");
  manifest = join(dir, "agentmine-release-manifest.json");
  checksums = join(dir, "SHA256SUMS");
  mkdirSync(binariesDir);
  mkdirSync(artifactsDir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFakeExecutable(target: string, mode = 0o755): string {
  const path = join(binariesDir, target);
  const data = {
    agentmine_version: VERSION,
    runtime: "bun-standalone",
    runtime_version: BUN_VERSION,
    target,
    bun_version: BUN_VERSION,
    source_commit: SOURCE_COMMIT,
  };
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `printf '%s\\n' '${JSON.stringify({
        version: 1,
        status: "success",
        command: "agentmine version",
        data,
      })}'`,
      "",
    ].join("\n"),
  );
  chmodSync(path, mode);
  return path;
}

async function packageAll(): Promise<void> {
  for (const { target } of TARGETS) {
    await packageStandalone({
      binary: writeFakeExecutable(target),
      target,
      outputDir: artifactsDir,
      version: VERSION,
      sourceCommit: SOURCE_COMMIT,
      bunVersion: BUN_VERSION,
    });
  }
}

function options() {
  return {
    artifactsDir,
    manifest,
    checksums,
    version: VERSION,
    sourceCommit: SOURCE_COMMIT,
    bunVersion: BUN_VERSION,
  };
}

describe("standalone release artifacts", () => {
  it(
    "packages the exact target set and verifies canonical metadata",
    async () => {
      await packageAll();
      const generated = await createReleaseManifest(options());
      expect(generated.artifacts.map((entry) => entry.target)).toEqual(
        TARGETS.map((entry) => entry.target),
      );
      expect(generated.artifacts.every((entry) => entry.size > 0)).toBe(true);
      expect(
        generated.artifacts.every((entry) =>
          /^[0-9a-f]{64}$/u.test(entry.sha256),
        ),
      ).toBe(true);

      await expect(verifyReleaseManifest(options())).resolves.toEqual(
        generated,
      );
      expect(readFileSync(manifest, "utf8")).toBe(
        `${JSON.stringify(generated, null, 2)}\n`,
      );
      expect(readFileSync(checksums, "utf8").trim().split("\n")).toHaveLength(
        3,
      );
    },
    ARCHIVE_TEST_TIMEOUT,
  );

  it(
    "rejects a missing target before writing a manifest",
    async () => {
      await packageAll();
      rmSync(join(artifactsDir, `agentmine-v${VERSION}-linux-x64.tar.gz`));
      await expect(createReleaseManifest(options())).rejects.toThrow(
        "archive set is incomplete",
      );
    },
    ARCHIVE_TEST_TIMEOUT,
  );

  it(
    "rejects an extra archive member",
    async () => {
      await packageAll();
      const badRoot = join(dir, "bad-root");
      mkdirSync(badRoot);
      writeFileSync(join(badRoot, "agentmine"), "not used");
      writeFileSync(join(badRoot, "unexpected"), "not allowed");
      const archive = join(
        artifactsDir,
        `agentmine-v${VERSION}-darwin-arm64.tar.gz`,
      );
      rmSync(archive);
      execFileSync("tar", [
        "-czf",
        archive,
        "-C",
        badRoot,
        "agentmine",
        "unexpected",
      ]);
      await expect(createReleaseManifest(options())).rejects.toThrow(
        "must contain only root-level agentmine",
      );
    },
    ARCHIVE_TEST_TIMEOUT,
  );

  it(
    "rejects a non-executable archive member",
    async () => {
      await packageAll();
      const badRoot = join(dir, "bad-mode");
      mkdirSync(badRoot);
      const executable = join(badRoot, "agentmine");
      writeFileSync(executable, "not executable");
      chmodSync(executable, 0o644);
      const archive = join(
        artifactsDir,
        `agentmine-v${VERSION}-darwin-x64.tar.gz`,
      );
      rmSync(archive);
      execFileSync("tar", ["-czf", archive, "-C", badRoot, "agentmine"]);
      await expect(createReleaseManifest(options())).rejects.toThrow(
        "owner-executable",
      );
    },
    ARCHIVE_TEST_TIMEOUT,
  );

  it(
    "rejects changed archive bytes and checksums",
    async () => {
      await packageAll();
      await createReleaseManifest(options());
      const archive = join(
        artifactsDir,
        `agentmine-v${VERSION}-linux-x64.tar.gz`,
      );
      writeFileSync(
        archive,
        Buffer.concat([readFileSync(archive), Buffer.from([0])]),
      );
      await expect(verifyReleaseManifest(options())).rejects.toThrow(
        "artifact metadata does not match bytes",
      );
    },
    ARCHIVE_TEST_TIMEOUT,
  );

  it(
    "rejects unsupported manifest fields even when JSON is canonical",
    async () => {
      await packageAll();
      const generated = await createReleaseManifest(options());
      writeFileSync(
        manifest,
        `${JSON.stringify({ ...generated, timestamp: 123 }, null, 2)}\n`,
      );
      await expect(verifyReleaseManifest(options())).rejects.toThrow(
        "unsupported fields",
      );
    },
    ARCHIVE_TEST_TIMEOUT,
  );
});
