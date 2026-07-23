#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const TARGETS = Object.freeze([
  {
    target: "bun-darwin-arm64",
    platform: "darwin-arm64",
  },
  {
    target: "bun-darwin-x64",
    platform: "darwin-x64",
  },
  {
    target: "bun-linux-x64-baseline",
    platform: "linux-x64",
  },
]);

const TARGET_BY_NAME = new Map(TARGETS.map((entry) => [entry.target, entry]));
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

class UsageError extends Error {}

function assetFilename(version, platform) {
  return `agentmine-v${version}-${platform}.tar.gz`;
}

function parseOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (!arg?.startsWith("--") || !allowed.has(arg) || !value) {
      throw new UsageError(`Unknown or incomplete argument: ${arg ?? ""}`);
    }
    const key = arg.slice(2);
    if (options[key] !== undefined) {
      throw new UsageError(`Duplicate argument: ${arg}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function requireOption(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError(`--${key} is required`);
  }
  return value;
}

function validateIdentity({ version, sourceCommit, bunVersion }) {
  if (!SEMVER.test(version)) {
    throw new UsageError("--version must be a semantic version");
  }
  if (!GIT_SHA.test(sourceCommit)) {
    throw new UsageError(
      "--source-commit must be a lowercase 40-character Git SHA",
    );
  }
  if (!SEMVER.test(bunVersion)) {
    throw new UsageError("--bun-version must be a semantic version");
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${basename(command)} exited ${exitCode}: ${stderr.slice(0, 500)}${stdout.slice(0, 500)}`,
        ),
      );
    });
  });
}

async function inspectExecutable(
  executable,
  { version, target, sourceCommit, bunVersion },
) {
  const metadata = await lstat(executable);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("standalone executable must be a regular file");
  }
  if ((metadata.mode & 0o100) === 0) {
    throw new Error("standalone executable must have its owner execute bit");
  }

  const { stdout } = await run(executable, ["version"]);
  const lines = stdout.trim().split("\n");
  if (lines.length !== 1) {
    throw new Error("agentmine version must emit exactly one JSON line");
  }
  let envelope;
  try {
    envelope = JSON.parse(lines[0]);
  } catch {
    throw new Error("agentmine version did not emit valid JSON");
  }
  const expected = {
    agentmine_version: version,
    runtime: "bun-standalone",
    runtime_version: bunVersion,
    target,
    bun_version: bunVersion,
    source_commit: sourceCommit,
  };
  if (
    envelope?.version !== 1 ||
    envelope?.status !== "success" ||
    envelope?.command !== "agentmine version" ||
    JSON.stringify(envelope?.data) !== JSON.stringify(expected)
  ) {
    throw new Error("standalone executable identity does not match build inputs");
  }
}

async function inspectArchive(
  archive,
  identity,
  expectedFilename,
  execute = true,
) {
  if (basename(archive) !== expectedFilename) {
    throw new Error(`unexpected archive filename: ${basename(archive)}`);
  }
  const metadata = await lstat(archive);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${expectedFilename} must be a regular file`);
  }

  const { stdout: listing } = await run("tar", ["-tzf", archive]);
  if (listing !== "agentmine\n") {
    throw new Error(`${expectedFilename} must contain only root-level agentmine`);
  }

  const extractionRoot = await mkdtemp(
    join(tmpdir(), "agentmine-release-verify-"),
  );
  try {
    await run("tar", ["-xzf", archive, "-C", extractionRoot]);
    const executable = join(extractionRoot, "agentmine");
    const executableMetadata = await lstat(executable);
    if (
      !executableMetadata.isFile() ||
      executableMetadata.isSymbolicLink() ||
      (executableMetadata.mode & 0o100) === 0
    ) {
      throw new Error(
        `${expectedFilename} must contain a regular owner-executable agentmine`,
      );
    }
    if (execute) await inspectExecutable(executable, identity);
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }

  const bytes = await readFile(archive);
  return {
    size: metadata.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function packageStandalone(options) {
  validateIdentity(options);
  const target = TARGET_BY_NAME.get(options.target);
  if (!target) {
    throw new UsageError(
      `--target must be one of: ${TARGETS.map((entry) => entry.target).join(", ")}`,
    );
  }
  const binary = resolve(options.binary);
  const outputDir = resolve(options.outputDir);
  await inspectExecutable(binary, options);
  await chmod(binary, 0o755);

  const filename = assetFilename(options.version, target.platform);
  const archive = join(outputDir, filename);
  try {
    await lstat(archive);
    throw new Error(`refusing to overwrite existing archive: ${filename}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const archiveRoot = await mkdtemp(join(tmpdir(), "agentmine-release-pack-"));
  try {
    const stagedBinary = join(archiveRoot, "agentmine");
    await copyFile(binary, stagedBinary);
    await chmod(stagedBinary, 0o755);
    await run("tar", ["-czf", archive, "-C", archiveRoot, "agentmine"]);
  } finally {
    await rm(archiveRoot, { recursive: true, force: true });
  }

  const digest = await inspectArchive(archive, options, filename);
  return {
    target: options.target,
    filename,
    archive,
    ...digest,
  };
}

function canonicalManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function canonicalChecksums(artifacts) {
  return `${artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.filename}`)
    .join("\n")}\n`;
}

async function collectArtifacts(options) {
  const expectedNames = new Set(
    TARGETS.map((entry) => assetFilename(options.version, entry.platform)),
  );
  const entries = await readdir(options.artifactsDir, { withFileTypes: true });
  const archiveNames = entries
    .filter((entry) => entry.name.endsWith(".tar.gz"))
    .map((entry) => entry.name)
    .sort();
  if (
    archiveNames.length !== expectedNames.size ||
    archiveNames.some((name) => !expectedNames.has(name))
  ) {
    throw new Error("standalone archive set is incomplete or unexpected");
  }

  const artifacts = [];
  for (const entry of TARGETS) {
    const filename = assetFilename(options.version, entry.platform);
    const identity = { ...options, target: entry.target };
    const digest = await inspectArchive(
      join(options.artifactsDir, filename),
      identity,
      filename,
      false,
    );
    artifacts.push({
      target: entry.target,
      filename,
      size: digest.size,
      sha256: digest.sha256,
    });
  }
  return artifacts;
}

export async function createReleaseManifest(options) {
  validateIdentity(options);
  const artifacts = await collectArtifacts(options);
  const manifest = {
    schema_version: 1,
    agentmine_version: options.version,
    source_commit: options.sourceCommit,
    bun_version: options.bunVersion,
    artifacts,
  };
  await writeFile(options.manifest, canonicalManifest(manifest), "utf8");
  await writeFile(
    options.checksums,
    canonicalChecksums(artifacts),
    "utf8",
  );
  return manifest;
}

function parseManifest(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "agentmine_version,artifacts,bun_version,schema_version,source_commit"
  ) {
    throw new Error("release manifest has unsupported fields");
  }
  if (
    value.schema_version !== 1 ||
    !SEMVER.test(value.agentmine_version) ||
    !GIT_SHA.test(value.source_commit) ||
    !SEMVER.test(value.bun_version) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length !== TARGETS.length
  ) {
    throw new Error("release manifest identity or artifact set is invalid");
  }
  for (const artifact of value.artifacts) {
    if (
      typeof artifact !== "object" ||
      artifact === null ||
      Array.isArray(artifact) ||
      Object.keys(artifact).sort().join(",") !==
        "filename,sha256,size,target" ||
      !TARGET_BY_NAME.has(artifact.target) ||
      typeof artifact.filename !== "string" ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0 ||
      !SHA256.test(artifact.sha256)
    ) {
      throw new Error("release manifest contains an invalid artifact");
    }
  }
  return value;
}

export async function verifyReleaseManifest(options) {
  validateIdentity(options);
  const manifestText = await readFile(options.manifest, "utf8");
  let decoded;
  try {
    decoded = JSON.parse(manifestText);
  } catch {
    throw new Error("release manifest is not valid JSON");
  }
  const manifest = parseManifest(decoded);
  if (manifestText !== canonicalManifest(manifest)) {
    throw new Error("release manifest is not canonical JSON");
  }
  if (
    manifest.agentmine_version !== options.version ||
    manifest.source_commit !== options.sourceCommit ||
    manifest.bun_version !== options.bunVersion
  ) {
    throw new Error("release manifest identity does not match expected inputs");
  }

  const actualArtifacts = await collectArtifacts(options);
  if (
    JSON.stringify(manifest.artifacts) !== JSON.stringify(actualArtifacts)
  ) {
    throw new Error("release manifest artifact metadata does not match bytes");
  }
  const checksums = await readFile(options.checksums, "utf8");
  if (checksums !== canonicalChecksums(actualArtifacts)) {
    throw new Error("release checksum file does not match artifact bytes");
  }
  return manifest;
}

async function main(argv) {
  const command = argv[0];
  if (command === "package") {
    const values = parseOptions(
      argv.slice(1),
      new Set([
        "--binary",
        "--target",
        "--output-dir",
        "--version",
        "--source-commit",
        "--bun-version",
      ]),
    );
    return {
      command: "agentmine package-standalone",
      data: await packageStandalone({
        binary: requireOption(values, "binary"),
        target: requireOption(values, "target"),
        outputDir: requireOption(values, "output-dir"),
        version: requireOption(values, "version"),
        sourceCommit: requireOption(values, "source-commit"),
        bunVersion: requireOption(values, "bun-version"),
      }),
    };
  }

  if (command === "manifest" || command === "verify") {
    const values = parseOptions(
      argv.slice(1),
      new Set([
        "--artifacts-dir",
        "--manifest",
        "--checksums",
        "--version",
        "--source-commit",
        "--bun-version",
      ]),
    );
    const options = {
      artifactsDir: resolve(requireOption(values, "artifacts-dir")),
      manifest: resolve(requireOption(values, "manifest")),
      checksums: resolve(requireOption(values, "checksums")),
      version: requireOption(values, "version"),
      sourceCommit: requireOption(values, "source-commit"),
      bunVersion: requireOption(values, "bun-version"),
    };
    return {
      command: `agentmine ${command}-standalone-release`,
      data:
        command === "manifest"
          ? await createReleaseManifest(options)
          : await verifyReleaseManifest(options),
    };
  }

  throw new UsageError("command must be package, manifest, or verify");
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(
      `${JSON.stringify({
        version: 1,
        status: "success",
        ...result,
        traceId: randomUUID(),
      })}\n`,
    );
  } catch (error) {
    const usage = error instanceof UsageError;
    process.stdout.write(
      `${JSON.stringify({
        version: 1,
        status: "error",
        command: "agentmine standalone-artifacts",
        data: null,
        errors: [
          {
            code: usage ? 1000 : 2000,
            name: usage ? "VALIDATION_ERROR" : "ARTIFACT_VERIFICATION_FAILED",
            message: error instanceof Error ? error.message : String(error),
            category: usage ? "user" : "system",
            retryable: false,
          },
        ],
        traceId: randomUUID(),
      })}\n`,
    );
    process.exit(usage ? 2 : 3);
  }
}
