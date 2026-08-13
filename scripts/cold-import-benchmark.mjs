#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  access,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");

export const DEFAULT_TARGET_BYTES = 512 * 1024 * 1024;
export const DEFAULT_SELECTED_FILES = 1_000;
export const MIN_SELECTED_FILES = 1_000;
export const DEFAULT_FREE_BYTES_FLOOR = 8 * 1024 * 1024 * 1024;
export const DEFAULT_DB_WAL_BYTE_CAP = 2 * 1024 * 1024 * 1024;
export const DEFAULT_REPETITIONS = 3;

const STRATA_COUNT = 10;
const STRATUM_SEED_RATIO = 0.02;
const TARGET_TOLERANCE_RATIO = 0.05;
const MONITOR_INTERVAL_MS = 100;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const GNU_TIME = "/usr/bin/time";
const VARIANT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ERROR_CODES = {
  VALIDATION_ERROR: 1_000,
  BENCHMARK_FAILED: 2_000,
  SAFETY_LIMIT: 3_000,
  BENCHMARK_INTERRUPTED: 3_001,
};
const GNU_TIME_FORMAT = [
  "wall_seconds=%e",
  "user_seconds=%U",
  "system_seconds=%S",
  "max_rss_kib=%M",
  "exit_status=%x",
].join("\\n");

const CliEnvelopeSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["success", "partial", "error"]),
    command: z.string(),
    data: z.unknown().nullable(),
    errors: z.array(z.unknown()).optional(),
    _meta: z.object({ duration_ms: z.number() }).passthrough().optional(),
  })
  .passthrough();

const NormalizeDataSchema = z
  .object({
    sources: z.array(z.string()),
    files_scanned: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    skipped_up_to_date: z.number().int().nonnegative(),
    skipped_unchanged: z.number().int().nonnegative(),
    skipped_empty: z.number().int().nonnegative(),
    skipped_by_filter: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    redactions: z.number().int().nonnegative(),
    redacted: z.boolean(),
    dry_run: z.boolean(),
  })
  .passthrough();

const RuntimeDataSchema = z
  .object({
    agentmine_version: z.string(),
    runtime: z.enum(["node", "bun-standalone"]),
    runtime_version: z.string(),
    target: z.string().nullable(),
    bun_version: z.string().nullable(),
    source_commit: z.string().nullable(),
  })
  .strict();

class UsageError extends Error {}
class SafetyError extends Error {}
class BenchmarkInterruptedError extends Error {
  constructor(signal) {
    super(`Benchmark interrupted by ${signal}`);
    this.signal = signal;
  }
}

const activeProcessGroups = new Set();

function parsePositiveInteger(value, option) {
  if (!/^\d+$/u.test(value)) {
    throw new UsageError(`${option} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${option} must be a positive safe integer`);
  }
  return parsed;
}

function parseCutoff(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
  ) {
    throw new UsageError("--cutoff must be an ISO-8601 UTC timestamp");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds > Date.now()) {
    throw new UsageError("--cutoff must be a valid timestamp not in the future");
  }
  return {
    milliseconds,
    iso: new Date(milliseconds).toISOString(),
  };
}

function parseArgs(argv) {
  const options = {
    nodeArgs: [],
    bunArgs: [],
    repetitions: DEFAULT_REPETITIONS,
    selectedFiles: DEFAULT_SELECTED_FILES,
    targetBytes: DEFAULT_TARGET_BYTES,
    freeBytesFloor: DEFAULT_FREE_BYTES_FLOOR,
    dbWalByteCap: DEFAULT_DB_WAL_BYTE_CAP,
    stageMode: "hardlink",
    aRuntime: "node",
    loweredFreeBytesFloor: false,
    loweredDbWalByteCap: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--node-arg" || arg === "--bun-arg") {
      if (value === undefined) {
        throw new UsageError(`${arg} requires a value`);
      }
      if (arg === "--node-arg") options.nodeArgs.push(value);
      else options.bunArgs.push(value);
      index += 1;
      continue;
    }
    if (!arg?.startsWith("--") || value === undefined) {
      throw new UsageError(`Unknown or incomplete argument: ${arg ?? ""}`);
    }
    switch (arg) {
      case "--archive-root":
        options.archiveRoot = value;
        break;
      case "--work-dir":
        options.workDir = value;
        break;
      case "--cutoff": {
        const cutoff = parseCutoff(value);
        options.cutoff = cutoff.iso;
        options.cutoffMs = cutoff.milliseconds;
        break;
      }
      case "--node-command":
        options.nodeCommand = value;
        break;
      case "--bun-command":
        options.bunCommand = value;
        break;
      case "--node-artifact":
        options.nodeArtifact = value;
        break;
      case "--bun-artifact":
        options.bunArtifact = value;
        break;
      case "--variant":
        if (!VARIANT_ID.test(value)) {
          throw new UsageError(
            "--variant must be a lowercase identifier using letters, digits, dot, underscore, or hyphen",
          );
        }
        options.variant = value;
        break;
      case "--repetitions":
        options.repetitions = parsePositiveInteger(value, arg);
        break;
      case "--selected-files":
        options.selectedFiles = parsePositiveInteger(value, arg);
        break;
      case "--target-bytes":
        options.targetBytes = parsePositiveInteger(value, arg);
        break;
      case "--free-bytes-floor":
        options.freeBytesFloor = parsePositiveInteger(value, arg);
        options.loweredFreeBytesFloor =
          options.freeBytesFloor < DEFAULT_FREE_BYTES_FLOOR;
        break;
      case "--db-wal-byte-cap":
        options.dbWalByteCap = parsePositiveInteger(value, arg);
        options.loweredDbWalByteCap =
          options.dbWalByteCap < DEFAULT_DB_WAL_BYTE_CAP;
        break;
      case "--stage-mode":
        if (value !== "hardlink" && value !== "copy") {
          throw new UsageError("--stage-mode must be hardlink or copy");
        }
        options.stageMode = value;
        break;
      case "--a-runtime":
        if (value !== "node" && value !== "bun") {
          throw new UsageError("--a-runtime must be node or bun");
        }
        options.aRuntime = value;
        break;
      default:
        throw new UsageError(`Unknown argument: ${arg}`);
    }
    index += 1;
  }

  for (const key of [
    "archiveRoot",
    "workDir",
    "cutoff",
    "nodeCommand",
    "bunCommand",
    "nodeArtifact",
    "bunArtifact",
    "variant",
  ]) {
    if (typeof options[key] !== "string" || options[key].length === 0) {
      throw new UsageError(`--${key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)} is required`);
    }
  }
  if (options.repetitions < DEFAULT_REPETITIONS) {
    throw new UsageError(
      `--repetitions must be at least ${DEFAULT_REPETITIONS}`,
    );
  }
  if (options.selectedFiles < MIN_SELECTED_FILES) {
    throw new UsageError(
      `--selected-files must be at least ${MIN_SELECTED_FILES}`,
    );
  }
  if (options.dbWalByteCap > DEFAULT_DB_WAL_BYTE_CAP) {
    throw new UsageError(
      `--db-wal-byte-cap cannot exceed ${DEFAULT_DB_WAL_BYTE_CAP}`,
    );
  }
  return options;
}

function compareCandidate(a, b) {
  return a.size - b.size || a.relativePath.localeCompare(b.relativePath);
}

/**
 * Select a deterministic, size-stratified fixture near the requested byte
 * target. Each rank-decile contributes a seed; remaining slots greedily track
 * the still-required average size.
 */
export function selectStratifiedFiles(
  input,
  {
    selectedFiles,
    targetBytes,
    strataCount = STRATA_COUNT,
    seedRatio = STRATUM_SEED_RATIO,
    toleranceRatio = TARGET_TOLERANCE_RATIO,
  },
) {
  const byIdentity = new Map();
  for (const candidate of input) {
    const prior = byIdentity.get(candidate.identity);
    if (!prior || candidate.relativePath.localeCompare(prior.relativePath) < 0) {
      byIdentity.set(candidate.identity, candidate);
    }
  }
  const candidates = [...byIdentity.values()].sort(compareCandidate);
  if (candidates.length < selectedFiles) {
    throw new UsageError(
      `Archive has ${candidates.length} unique nonempty JSONL files; ${selectedFiles} required`,
    );
  }

  const selected = [];
  const remaining = [];
  const stratumByIdentity = new Map();
  const seedPerStratum = Math.max(1, Math.floor(selectedFiles * seedRatio));

  for (let stratum = 0; stratum < strataCount; stratum += 1) {
    const start = Math.floor((stratum * candidates.length) / strataCount);
    const end = Math.floor(
      ((stratum + 1) * candidates.length) / strataCount,
    );
    const bucket = candidates.slice(start, end);
    const take = Math.min(seedPerStratum, bucket.length);
    const seedIndexes = new Set();
    for (let index = 0; index < take; index += 1) {
      seedIndexes.add(Math.floor(((index + 0.5) * bucket.length) / take));
    }
    for (let index = 0; index < bucket.length; index += 1) {
      const candidate = bucket[index];
      stratumByIdentity.set(candidate.identity, stratum);
      if (seedIndexes.has(index)) selected.push(candidate);
      else remaining.push(candidate);
    }
  }

  remaining.sort(compareCandidate);
  let selectedBytes = selected.reduce((sum, file) => sum + file.size, 0);
  while (selected.length < selectedFiles) {
    const slots = selectedFiles - selected.length;
    const desiredSize = (targetBytes - selectedBytes) / slots;
    let low = 0;
    let high = remaining.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (remaining[middle].size < desiredSize) low = middle + 1;
      else high = middle;
    }
    const indexes = [low - 1, low].filter(
      (index) => index >= 0 && index < remaining.length,
    );
    let chosenIndex = indexes[0];
    for (const index of indexes) {
      const current = remaining[chosenIndex];
      const candidate = remaining[index];
      const currentDistance = Math.abs(current.size - desiredSize);
      const candidateDistance = Math.abs(candidate.size - desiredSize);
      if (
        candidateDistance < currentDistance ||
        (candidateDistance === currentDistance &&
          candidate.relativePath.localeCompare(current.relativePath) < 0)
      ) {
        chosenIndex = index;
      }
    }
    const [chosen] = remaining.splice(chosenIndex, 1);
    selected.push(chosen);
    selectedBytes += chosen.size;
  }

  const targetDeltaRatio = Math.abs(selectedBytes - targetBytes) / targetBytes;
  if (targetDeltaRatio > toleranceRatio) {
    throw new UsageError(
      `Selected fixture is ${(targetDeltaRatio * 100).toFixed(2)}% from the byte target; maximum is ${(toleranceRatio * 100).toFixed(2)}%`,
    );
  }

  const strata = Array.from({ length: strataCount }, (_, index) => {
    const eligible = candidates.filter(
      (file) => stratumByIdentity.get(file.identity) === index,
    );
    const chosen = selected.filter(
      (file) => stratumByIdentity.get(file.identity) === index,
    );
    return {
      stratum: index + 1,
      eligible_files: eligible.length,
      eligible_bytes: eligible.reduce((sum, file) => sum + file.size, 0),
      selected_files: chosen.length,
      selected_bytes: chosen.reduce((sum, file) => sum + file.size, 0),
      min_bytes: eligible[0]?.size ?? 0,
      max_bytes: eligible.at(-1)?.size ?? 0,
    };
  });

  return {
    files: selected.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    ),
    eligibleFiles: candidates.length,
    eligibleBytes: candidates.reduce((sum, file) => sum + file.size, 0),
    selectedBytes,
    targetDeltaRatio,
    strata,
  };
}

export function buildAbbaSchedule(repetitions, aRuntime = "node") {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
    throw new UsageError("repetitions must be a positive integer");
  }
  if (aRuntime !== "node" && aRuntime !== "bun") {
    throw new UsageError("A runtime must be node or bun");
  }
  const bRuntime = aRuntime === "node" ? "bun" : "node";
  const blockPattern = [aRuntime, bRuntime, bRuntime, aRuntime];
  return Array.from({ length: repetitions }, (_, block) =>
    blockPattern.map((runtime, position) => ({
      block: block + 1,
      position: position + 1,
      runtime,
    })),
  ).flat();
}

export function parseGnuTime(text) {
  const values = new Map();
  for (const line of text.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const result = {
    wallSeconds: Number(values.get("wall_seconds")),
    userSeconds: Number(values.get("user_seconds")),
    systemSeconds: Number(values.get("system_seconds")),
    maxRssKib: Number(values.get("max_rss_kib")),
    exitStatus: Number(values.get("exit_status")),
  };
  if (
    !Number.isFinite(result.wallSeconds) ||
    !Number.isFinite(result.userSeconds) ||
    !Number.isFinite(result.systemSeconds) ||
    !Number.isSafeInteger(result.maxRssKib) ||
    !Number.isSafeInteger(result.exitStatus)
  ) {
    throw new Error("GNU time output was incomplete");
  }
  return result;
}

export function pathIsWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

export function assertWorkDirOutsideRepositories(workRoot, repositoryRoots) {
  for (const repositoryRoot of repositoryRoots) {
    if (
      pathIsWithin(repositoryRoot, workRoot) ||
      pathIsWithin(workRoot, repositoryRoot)
    ) {
      throw new UsageError(
        "--work-dir must resolve outside every registered Git worktree",
      );
    }
  }
}

/** List only top-level Claude sessions: `<project>/<session>.jsonl`. */
export async function listClaudeRootJsonl(root, cutoffMs) {
  const candidates = [];
  const projects = await readdir(root, { withFileTypes: true });
  projects.sort((a, b) => a.name.localeCompare(b.name));
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectRoot = join(root, project.name);
    const entries = await readdir(projectRoot, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const absolutePath = join(projectRoot, entry.name);
      const metadata = await stat(absolutePath);
      if (metadata.size === 0 || metadata.mtimeMs > cutoffMs) continue;
      candidates.push({
        absolutePath,
        relativePath: relative(root, absolutePath).split(sep).join("/"),
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
        ino: metadata.ino,
        dev: metadata.dev,
        // Claude root-session filenames are the source session identifier.
        // Deduplicating this key prevents one logical session from being timed
        // repeatedly under multiple archive paths.
        identity: basename(entry.name, ".jsonl"),
      });
    }
  }
  return candidates;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new BenchmarkInterruptedError("unknown signal");
  }
}

function statsMatch(left, right) {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.ino === right.ino &&
    left.dev === right.dev
  );
}

async function sha256File(path, signal) {
  throwIfAborted(signal);
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path, { signal })) {
      hash.update(chunk);
    }
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  return hash.digest("hex");
}

async function snapshotRegularFile(path, signal) {
  const before = await stat(path);
  if (!before.isFile()) {
    throw new UsageError("Benchmark inputs must be regular files");
  }
  const sha256 = await sha256File(path, signal);
  const after = await stat(path);
  if (!statsMatch(before, after)) {
    throw new SafetyError("A benchmark input changed while it was being hashed");
  }
  return { size: after.size, sha256 };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function listArtifactFiles(root) {
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink()) {
    throw new UsageError("Artifact roots must not be symbolic links");
  }
  if (metadata.isFile()) return [{ absolutePath: root, relativePath: "." }];
  if (!metadata.isDirectory()) {
    throw new UsageError("Artifact roots must be regular files or directories");
  }

  const files = [];
  const visit = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new UsageError("Artifact trees must not contain symbolic links");
      }
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) files.push({ absolutePath, relativePath });
      else throw new UsageError("Artifact trees must contain only regular files");
    }
  };
  await visit(root, "");
  if (files.length === 0) throw new UsageError("Artifact directories must not be empty");
  return files;
}

export async function snapshotArtifact(path, signal) {
  const requestedRoot = resolve(path);
  if ((await lstat(requestedRoot)).isSymbolicLink()) {
    throw new UsageError("Artifact roots must not be symbolic links");
  }
  const root = await realpath(requestedRoot);
  const metadata = await lstat(root);
  const files = await listArtifactFiles(root);
  const manifest = createHash("sha256");
  let totalBytes = 0;
  let singleFileSha256 = null;
  for (const file of files) {
    throwIfAborted(signal);
    const snapshot = await snapshotRegularFile(file.absolutePath, signal);
    totalBytes += snapshot.size;
    singleFileSha256 = snapshot.sha256;
    manifest.update(`${snapshot.sha256}  ${file.relativePath}\n`);
  }
  return {
    root,
    kind: metadata.isFile() ? "file" : "directory",
    files: files.length,
    bytes: totalBytes,
    sha256:
      metadata.isFile() && singleFileSha256 !== null
        ? singleFileSha256
        : manifest.digest("hex"),
  };
}

function publicArtifactSnapshot(snapshot) {
  return {
    kind: snapshot.kind,
    files: snapshot.files,
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
  };
}

export function assertArtifactSnapshot(expected, actual, runtime) {
  if (
    expected.kind !== actual.kind ||
    expected.files !== actual.files ||
    expected.bytes !== actual.bytes ||
    expected.sha256 !== actual.sha256
  ) {
    throw new SafetyError(`${runtime} artifact changed during the benchmark`);
  }
}

async function resolveExecutable(command) {
  const candidates = command.includes(sep)
    ? [resolve(command)]
    : (process.env.PATH ?? "/usr/bin:/bin")
        .split(":")
        .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
    }
  }
  throw new UsageError("A benchmark runtime command could not be resolved");
}

async function invocationPaths(invocation) {
  const paths = [invocation.command];
  for (const argument of invocation.args) {
    if (argument.startsWith("-")) continue;
    try {
      paths.push(await realpath(resolve(argument)));
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
  }
  return paths;
}

async function prepareRuntimeArtifact(options, runtime, signal) {
  const rawInvocation = runtimeInvocation(options, runtime);
  const invocation = {
    command: await resolveExecutable(rawInvocation.command),
    args: rawInvocation.args,
  };
  const artifactPath =
    runtime === "node" ? options.nodeArtifact : options.bunArtifact;
  if (!isAbsolute(artifactPath)) {
    throw new UsageError(
      `--${runtime}-artifact must be an absolute file or directory path`,
    );
  }
  const artifact = await snapshotArtifact(artifactPath, signal);
  const bound = (await invocationPaths(invocation)).some((path) =>
    artifact.kind === "file"
      ? path === artifact.root
      : pathIsWithin(artifact.root, path),
  );
  if (!bound) {
    throw new UsageError(
      `${runtime} invocation must reference its declared artifact`,
    );
  }
  return { invocation, artifact };
}

function destinationForRelative(root, relativePath) {
  return join(root, ...relativePath.split("/"));
}

async function stageOne(source, destination, mode) {
  await mkdir(dirname(destination), { recursive: true });
  if (mode === "copy") {
    await copyFile(source, destination);
    return;
  }
  try {
    await link(source, destination);
  } catch (error) {
    if (error?.code === "EXDEV") {
      throw new UsageError(
        "Hardlink staging crossed filesystems; rerun with --stage-mode copy",
      );
    }
    throw error;
  }
}

async function availableBytes(path) {
  const fs = await statfs(path);
  return Number(fs.bavail) * Number(fs.bsize);
}

async function assertFreeBytes(path, floor) {
  const available = await availableBytes(path);
  if (available < floor) {
    throw new SafetyError(
      `Available disk is below the configured ${floor}-byte floor`,
    );
  }
  return available;
}

function sourceStatsMatch(left, right, allowCtimeChange) {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    (allowCtimeChange || left.ctimeMs === right.ctimeMs) &&
    left.ino === right.ino &&
    left.dev === right.dev
  );
}

async function assertSourceStillMatches(file, allowCtimeChange = false) {
  const current = await stat(file.absolutePath);
  if (!sourceStatsMatch(file, current, allowCtimeChange)) {
    throw new SafetyError("A source fixture file changed during staging");
  }
}

function fixtureManifestSha256(entries) {
  const hash = createHash("sha256");
  const sorted = [...entries].sort((left, right) =>
    compareText(
      `${left.kind}\0${left.relativePath}`,
      `${right.kind}\0${right.relativePath}`,
    ),
  );
  for (const entry of sorted) {
    hash.update(
      `${entry.kind}\0${entry.relativePath}\0${entry.size}\0${entry.sha256}\n`,
    );
  }
  return hash.digest("hex");
}

function legacyFixtureManifestSha256(entries) {
  const hash = createHash("sha256");
  const jsonlEntries = entries
    .filter((entry) => entry.kind === "jsonl")
    .sort((left, right) => left.ordinal - right.ordinal);
  for (const entry of jsonlEntries) {
    hash.update(`${entry.ordinal}\0${entry.size}\0${entry.sha256}\n`);
  }
  return hash.digest("hex");
}

export async function stageFixture(
  selection,
  fixtureRoot,
  mode,
  freeBytesFloor,
  signal,
) {
  let supplementalFiles = 0;
  let supplementalBytes = 0;
  const stagedSupplemental = new Set();
  const entries = [];
  const stageRoot = join(
    fixtureRoot,
    "xdg",
    "agentmine",
    "sessions",
    "claude-code",
  );

  for (let index = 0; index < selection.files.length; index += 1) {
    throwIfAborted(signal);
    const file = selection.files[index];
    const available = await assertFreeBytes(fixtureRoot, freeBytesFloor);
    if (mode === "copy" && available - file.size < freeBytesFloor) {
      throw new SafetyError("Copy staging would cross the configured disk floor");
    }
    const destination = destinationForRelative(stageRoot, file.relativePath);
    await assertSourceStillMatches(file);
    await stageOne(file.absolutePath, destination, mode);
    // Creating a hardlink increments the inode's link count and therefore its
    // ctime. The remaining stat fields plus the destination hash still detect
    // replacement or content mutation without rejecting our own operation.
    await assertSourceStillMatches(file, mode === "hardlink");
    const snapshot = await snapshotRegularFile(destination, signal);
    if (snapshot.size !== file.size) {
      throw new SafetyError("A staged fixture file has an unexpected size");
    }
    entries.push({
      kind: "jsonl",
      ordinal: index,
      relativePath: file.relativePath,
      destination,
      ...snapshot,
    });

    const metadataSource = file.absolutePath.replace(/\.jsonl$/u, ".meta.json");
    const metadataRelative = file.relativePath.replace(
      /\.jsonl$/u,
      ".meta.json",
    );
    if (stagedSupplemental.has(metadataRelative)) continue;
    try {
      const metadataBefore = await stat(metadataSource);
      if (!metadataBefore.isFile()) continue;
      const metadataDestination = destinationForRelative(stageRoot, metadataRelative);
      const metadataAvailable = await assertFreeBytes(
        fixtureRoot,
        freeBytesFloor,
      );
      if (
        mode === "copy" &&
        metadataAvailable - metadataBefore.size < freeBytesFloor
      ) {
        throw new SafetyError(
          "Copy staging would cross the configured disk floor",
        );
      }
      await stageOne(metadataSource, metadataDestination, mode);
      const metadataAfter = await stat(metadataSource);
      if (
        !sourceStatsMatch(
          metadataBefore,
          metadataAfter,
          mode === "hardlink",
        )
      ) {
        throw new SafetyError("A source metadata file changed during staging");
      }
      const metadataSnapshot = await snapshotRegularFile(
        metadataDestination,
        signal,
      );
      stagedSupplemental.add(metadataRelative);
      supplementalFiles += 1;
      supplementalBytes += metadataSnapshot.size;
      entries.push({
        kind: "metadata",
        relativePath: metadataRelative,
        destination: metadataDestination,
        ...metadataSnapshot,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await assertFreeBytes(fixtureRoot, freeBytesFloor);
  return {
    manifestSha256: legacyFixtureManifestSha256(entries),
    treeManifestSha256: fixtureManifestSha256(entries),
    supplementalFiles,
    supplementalBytes,
    entries,
  };
}

export async function verifyStagedFixture(staged, signal) {
  const verified = [];
  for (const expected of staged.entries) {
    throwIfAborted(signal);
    const actual = await snapshotRegularFile(expected.destination, signal);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new SafetyError("The staged fixture changed during the benchmark");
    }
    verified.push({ ...expected, ...actual });
  }
  if (legacyFixtureManifestSha256(verified) !== staged.manifestSha256) {
    throw new SafetyError("The staged fixture manifest changed during the benchmark");
  }
  if (fixtureManifestSha256(verified) !== staged.treeManifestSha256) {
    throw new SafetyError("The staged fixture manifest changed during the benchmark");
  }
}

function runtimeInvocation(options, runtime) {
  if (runtime === "node") {
    return { command: options.nodeCommand, args: options.nodeArgs };
  }
  return { command: options.bunCommand, args: options.bunArgs };
}

function childEnvironment({ home, xdgDataHome, tmp, dbPath }) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_DATA_HOME: xdgDataHome,
    TMPDIR: tmp,
    LANG: "C.UTF-8",
    TZ: "UTC",
    NO_COLOR: "1",
    AGENTMINE_DB: dbPath,
  };
}

function appendBounded(current, chunk) {
  if (current.length >= MAX_CAPTURE_BYTES) return current;
  return (current + chunk.toString()).slice(0, MAX_CAPTURE_BYTES);
}

function registerProcessGroup(child) {
  if (child.pid !== undefined) activeProcessGroups.add(child.pid);
}

function unregisterProcessGroup(child) {
  if (child.pid !== undefined) activeProcessGroups.delete(child.pid);
}

function runCaptured(invocation, commandArgs, env, abortSignal) {
  throwIfAborted(abortSignal);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      invocation.command,
      [...invocation.args, ...commandArgs],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: true,
      },
    );
    registerProcessGroup(child);
    let stdout = "";
    let stderr = "";
    let finished = false;
    let abortReason = null;
    const abort = () => {
      abortReason =
        abortSignal?.reason instanceof Error
          ? abortSignal.reason
          : new BenchmarkInterruptedError("unknown signal");
      terminateProcessGroup(child.pid, "SIGTERM");
      const killTimer = setTimeout(
        () => {
          if (!finished) terminateProcessGroup(child.pid, "SIGKILL");
        },
        1_000,
      );
      killTimer.unref();
    };
    abortSignal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    const finish = (result, error) => {
      if (finished) return;
      finished = true;
      abortSignal?.removeEventListener("abort", abort);
      unregisterProcessGroup(child);
      if (abortReason) reject(abortReason);
      else if (error) reject(error);
      else resolvePromise({ ...result, stdout, stderr });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (exitCode, signal) => {
      finish({ exitCode, signal }, null);
    });
  });
}

function parseEnvelope(stdout, expectedCommand) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw new Error("Agentmine did not emit exactly one JSON stdout line");
  }
  let raw;
  try {
    raw = JSON.parse(lines[0]);
  } catch {
    throw new Error("Agentmine emitted invalid JSON");
  }
  const envelope = CliEnvelopeSchema.parse(raw);
  if (envelope.command !== expectedCommand) {
    throw new Error("Agentmine emitted an unexpected command envelope");
  }
  return envelope;
}

async function inspectRuntime(invocation, env, expectedRuntime, abortSignal) {
  const result = await runCaptured(
    invocation,
    ["version"],
    env,
    abortSignal,
  );
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new Error(`${expectedRuntime} runtime identity check failed`);
  }
  const envelope = parseEnvelope(result.stdout, "agentmine version");
  if (envelope.status !== "success") {
    throw new Error(`${expectedRuntime} runtime identity check failed`);
  }
  const data = RuntimeDataSchema.parse(envelope.data);
  const expected = expectedRuntime === "node" ? "node" : "bun-standalone";
  if (data.runtime !== expected) {
    throw new Error(`${expectedRuntime} command resolved to the wrong runtime`);
  }
  return data;
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

export async function dbWalBytes(dbPath) {
  const [dbBytes, walBytes] = await Promise.all([
    fileSize(dbPath),
    fileSize(`${dbPath}-wal`),
  ]);
  return { dbBytes, walBytes, totalBytes: dbBytes + walBytes };
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function terminateProcessGroup(pid, signal) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function runTimed({
  invocation,
  env,
  dbPath,
  runDirectory,
  freeBytesFloor,
  dbWalByteCap,
  abortSignal,
}) {
  throwIfAborted(abortSignal);
  await assertFreeBytes(runDirectory, freeBytesFloor);
  const timePath = join(runDirectory, "gnu-time.txt");
  const args = [
    "--quiet",
    "--output",
    timePath,
    "--format",
    GNU_TIME_FORMAT,
    invocation.command,
    ...invocation.args,
    "normalize",
    "--source",
    "claude-code",
  ];
  const started = process.hrtime.bigint();
  const child = spawn(GNU_TIME, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: true,
  });
  registerProcessGroup(child);
  let stdout = "";
  let stderr = "";
  let settled = false;
  let terminationError = null;
  let peakDbWalBytes = 0;
  const tripTermination = (error) => {
    if (terminationError !== null) return;
    terminationError = error;
    terminateProcessGroup(child.pid, "SIGTERM");
    const killTimer = setTimeout(() => {
      if (!settled) terminateProcessGroup(child.pid, "SIGKILL");
    }, 1_000);
    killTimer.unref();
  };
  const abort = () =>
    tripTermination(
      abortSignal?.reason instanceof Error
        ? abortSignal.reason
        : new BenchmarkInterruptedError("unknown signal"),
    );
  abortSignal?.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
    if (stdout.length >= MAX_CAPTURE_BYTES) {
      tripTermination(new SafetyError("stdout exceeded the capture cap"));
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
    if (stderr.length >= MAX_CAPTURE_BYTES) {
      tripTermination(new SafetyError("stderr exceeded the capture cap"));
    }
  });

  const completion = new Promise((resolvePromise) => {
    child.on("error", (error) =>
      resolvePromise({ exitCode: null, signal: null, error }),
    );
    child.on("close", (exitCode, signal) =>
      resolvePromise({ exitCode, signal, error: null }),
    );
  });

  const monitor = (async () => {
    try {
      while (!settled) {
        const sizes = await dbWalBytes(dbPath);
        peakDbWalBytes = Math.max(peakDbWalBytes, sizes.totalBytes);
        if (sizes.totalBytes > dbWalByteCap) {
          tripTermination(
            new SafetyError("database plus WAL exceeded the configured cap"),
          );
        }
        const free = await availableBytes(runDirectory);
        if (free < freeBytesFloor) {
          tripTermination(
            new SafetyError("available disk crossed the configured floor"),
          );
        }
        await delay(MONITOR_INTERVAL_MS);
      }
    } catch {
      tripTermination(new SafetyError("benchmark safety monitor failed"));
    }
  })();

  const completionResult = await completion;
  const finished = process.hrtime.bigint();
  settled = true;
  await monitor;
  abortSignal?.removeEventListener("abort", abort);
  unregisterProcessGroup(child);
  if (terminationError !== null) {
    terminateProcessGroup(child.pid, "SIGKILL");
    throw terminationError;
  }
  if (completionResult.error) {
    throw new Error("Failed to launch benchmark runtime");
  }
  const wallSeconds = Number(finished - started) / 1e9;
  const timing = parseGnuTime(await readFile(timePath, "utf8"));
  if (
    completionResult.exitCode !== 0 ||
    completionResult.signal !== null ||
    timing.exitStatus !== 0
  ) {
    throw new Error("Agentmine normalize benchmark process failed");
  }
  const finalSizes = await dbWalBytes(dbPath);
  peakDbWalBytes = Math.max(peakDbWalBytes, finalSizes.totalBytes);
  if (peakDbWalBytes > dbWalByteCap) {
    throw new SafetyError("database plus WAL exceeded the configured cap");
  }
  return {
    wallSeconds,
    timing,
    stdout,
    stderrSha256: createHash("sha256").update(stderr).digest("hex"),
    finalSizes,
    peakDbWalBytes,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function queryReceipt(db, id, sql, publishResults) {
  const rows = db.prepare(sql).all();
  return {
    id,
    row_count: rows.length,
    sha256: createHash("sha256").update(canonicalJson(rows)).digest("hex"),
    ...(publishResults ? { results: rows } : {}),
  };
}

async function inspectDatabase(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      "INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)",
    ).run();
    const integrityRows = db.prepare("PRAGMA integrity_check").all();
    const foreignKeyRows = db.prepare("PRAGMA foreign_key_check").all();
    const integrityOk =
      integrityRows.length === 1 &&
      integrityRows[0]?.integrity_check === "ok";
    if (!integrityOk) throw new Error("SQLite integrity_check failed");
    if (foreignKeyRows.length !== 0) {
      throw new Error("SQLite foreign_key_check failed");
    }

    const rowCounts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sessions) AS sessions,
           (SELECT COUNT(*) FROM messages) AS messages,
           (SELECT COUNT(*) FROM messages_fts) AS messages_fts,
           (SELECT COUNT(*) FROM tool_calls) AS tool_calls,
           (SELECT COUNT(*) FROM tool_outputs) AS tool_outputs,
           (SELECT COUNT(*) FROM raw_events) AS raw_events,
           (SELECT COUNT(*) FROM message_parts) AS message_parts,
           (SELECT COUNT(*) FROM dirty_sessions) AS dirty_sessions,
           (SELECT COUNT(*) FROM file_stat_cache) AS file_stat_cache`,
      )
      .get();
    const fixedQueries = [
      queryReceipt(
        db,
        "source-rollup",
        `SELECT source, COUNT(*) AS sessions,
                COALESCE(SUM(turn_count), 0) AS turns,
                COALESCE(SUM(tool_call_count), 0) AS tool_calls,
                COALESCE(SUM(redaction_count), 0) AS redactions
           FROM sessions GROUP BY source ORDER BY source`,
        true,
      ),
      queryReceipt(
        db,
        "role-counts",
        "SELECT role, COUNT(*) AS messages FROM messages GROUP BY role ORDER BY role",
        true,
      ),
      queryReceipt(
        db,
        "fts-error-count",
        "SELECT COUNT(*) AS matches FROM messages_fts WHERE messages_fts MATCH 'error'",
        true,
      ),
      queryReceipt(
        db,
        "session-content-fingerprint",
        `SELECT id, content_hash, turn_count, tool_call_count, redaction_count
           FROM sessions ORDER BY id`,
        false,
      ),
    ];
    return {
      rowCounts,
      checks: {
        integrity_check: "ok",
        foreign_key_violations: 0,
        fts_integrity: "ok",
      },
      fixedQueries,
    };
  } finally {
    db.close();
  }
}

function verificationDigest(inspection) {
  return createHash("sha256")
    .update(
      canonicalJson({
        rowCounts: inspection.rowCounts,
        fixedQueries: inspection.fixedQueries.map((query) => ({
          id: query.id,
          row_count: query.row_count,
          sha256: query.sha256,
        })),
      }),
    )
    .digest("hex");
}

export function assertNormalizeAccounting(normalize, rowCounts, selectedFiles) {
  const unexpectedSkips =
    normalize.skipped_up_to_date +
    normalize.skipped_unchanged +
    normalize.skipped_by_filter;
  if (
    normalize.failed !== 0 ||
    unexpectedSkips !== 0 ||
    normalize.processed + normalize.skipped_empty !== selectedFiles ||
    normalize.processed !== rowCounts?.sessions
  ) {
    throw new Error(
      "Normalize did not account for every distinct source file without session-id collisions",
    );
  }
}

function rounded(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeRuns(runs) {
  return Object.fromEntries(
    ["node", "bun"].map((runtime) => {
      const matches = runs.filter((run) => run.runtime === runtime);
      const metric = (key) => matches.map((run) => run[key]);
      return [
        runtime,
        {
          runs: matches.length,
          wall_seconds_median: rounded(median(metric("wall_seconds"))),
          wall_seconds_min: rounded(Math.min(...metric("wall_seconds"))),
          wall_seconds_max: rounded(Math.max(...metric("wall_seconds"))),
          user_seconds_median: rounded(median(metric("user_seconds"))),
          system_seconds_median: rounded(median(metric("system_seconds"))),
          max_rss_bytes_median: Math.round(median(metric("max_rss_bytes"))),
          db_wal_bytes_peak_max: Math.max(...metric("db_wal_bytes_peak")),
        },
      ];
    }),
  );
}

function safeRuntimeIdentity(data) {
  return {
    agentmine_version: data.agentmine_version,
    runtime: data.runtime,
    runtime_version: data.runtime_version,
    target: data.target,
    bun_version: data.bun_version,
    source_commit: data.source_commit,
  };
}

async function runGitCaptured(startDirectory, args, abortSignal) {
  const result = await runCaptured(
    { command: "git", args: ["-C", startDirectory] },
    args,
    process.env,
    abortSignal,
  );
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new UsageError("Unable to inspect registered Git worktrees");
  }
  return result.stdout;
}

export async function discoverRepositoryRoots(startDirectory, abortSignal) {
  const topLevelOutput = await runGitCaptured(
    startDirectory,
    ["rev-parse", "--show-toplevel"],
    abortSignal,
  );
  const topLevel = topLevelOutput.replace(/\r?\n$/u, "");
  if (
    !isAbsolute(topLevel) ||
    topLevel.includes("\n") ||
    topLevel.includes("\r")
  ) {
    throw new UsageError("Unable to resolve the current Git worktree");
  }
  const currentRoot = await realpath(topLevel);
  const worktreeOutput = await runGitCaptured(
    startDirectory,
    ["worktree", "list", "--porcelain", "-z"],
    abortSignal,
  );
  const roots = [currentRoot];
  for (const field of worktreeOutput.split("\0")) {
    if (!field.startsWith("worktree ")) continue;
    try {
      roots.push(await realpath(field.slice("worktree ".length)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { currentRoot, repositoryRoots: [...new Set(roots)] };
}

async function canonicalizePotentialPath(path) {
  let cursor = resolve(path);
  const missing = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missing);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function prepareRoots(options, abortSignal) {
  if (process.platform !== "linux") {
    throw new UsageError("The cold-import benchmark requires Linux and GNU time");
  }
  if (!isAbsolute(options.workDir)) {
    throw new UsageError("--work-dir must be an absolute path outside the repo");
  }
  const gitContext = await discoverRepositoryRoots(PACKAGE_ROOT, abortSignal);
  const { repositoryRoots } = gitContext;
  const unresolvedWorkRoot = await canonicalizePotentialPath(options.workDir);
  assertWorkDirOutsideRepositories(unresolvedWorkRoot, repositoryRoots);
  throwIfAborted(abortSignal);
  await mkdir(options.workDir, { recursive: true });
  const [workRoot, archiveRoot] = await Promise.all([
    realpath(options.workDir),
    realpath(resolve(options.archiveRoot)),
  ]);
  assertWorkDirOutsideRepositories(workRoot, repositoryRoots);
  const archiveMetadata = await stat(archiveRoot);
  if (!archiveMetadata.isDirectory()) {
    throw new UsageError("--archive-root must be a directory");
  }
  await access(GNU_TIME);
  await assertFreeBytes(workRoot, options.freeBytesFloor);
  throwIfAborted(abortSignal);
  const runRoot = await mkdtemp(join(workRoot, "agentmine-cold-import-"));
  const roots = {
    repoRoot: gitContext.currentRoot,
    repositoryRoots,
    workRoot,
    archiveRoot,
    runRoot,
    fixture: join(runRoot, "fixture"),
    runs: join(runRoot, "runs"),
    home: join(runRoot, "sandbox-home"),
    tmp: join(runRoot, "tmp"),
  };
  await Promise.all(
    [roots.fixture, roots.runs, roots.home, roots.tmp].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  return roots;
}

async function executeBenchmark(options, abortSignal) {
  const roots = await prepareRoots(options, abortSignal);
  const sensitivePaths = [
    ...roots.repositoryRoots,
    roots.workRoot,
    roots.archiveRoot,
    roots.runRoot,
    resolve(options.nodeArtifact),
    resolve(options.bunArtifact),
  ];
  let completed = false;
  try {
    const commonEnvironment = {
      home: roots.home,
      xdgDataHome: join(roots.fixture, "xdg"),
      tmp: roots.tmp,
      dbPath: join(roots.runs, "identity.db"),
    };
    const identityEnv = childEnvironment(commonEnvironment);
    const [nodeRuntime, bunRuntime] = await Promise.all([
      prepareRuntimeArtifact(options, "node", abortSignal),
      prepareRuntimeArtifact(options, "bun", abortSignal),
    ]);
    const nodeInvocation = nodeRuntime.invocation;
    const bunInvocation = bunRuntime.invocation;
    const [nodeIdentity, bunIdentity] = await Promise.all([
      inspectRuntime(nodeInvocation, identityEnv, "node", abortSignal),
      inspectRuntime(bunInvocation, identityEnv, "bun", abortSignal),
    ]);
    if (nodeIdentity.agentmine_version !== bunIdentity.agentmine_version) {
      throw new UsageError("Node and Bun artifacts have different Agentmine versions");
    }

    reportProgress("fixture.scan");
    const candidates = await listClaudeRootJsonl(
      roots.archiveRoot,
      options.cutoffMs,
    );
    const selection = selectStratifiedFiles(candidates, {
      selectedFiles: options.selectedFiles,
      targetBytes: options.targetBytes,
    });
    reportProgress("fixture.stage", {
      selected_files: selection.files.length,
      selected_bytes: selection.selectedBytes,
    });
    const staged = await stageFixture(
      selection,
      roots.fixture,
      options.stageMode,
      options.freeBytesFloor,
      abortSignal,
    );

    const schedule = buildAbbaSchedule(options.repetitions, options.aRuntime);
    const runs = [];
    let referenceDigest = null;
    for (let ordinal = 0; ordinal < schedule.length; ordinal += 1) {
      const slot = schedule[ordinal];
      const runDirectory = join(
        roots.runs,
        `${String(ordinal + 1).padStart(2, "0")}-${slot.runtime}`,
      );
      await mkdir(runDirectory, { recursive: true });
      const dbPath = join(runDirectory, "sessions.db");
      const env = childEnvironment({
        home: roots.home,
        xdgDataHome: join(roots.fixture, "xdg"),
        tmp: roots.tmp,
        dbPath,
      });
      reportProgress("run.start", {
        ordinal: ordinal + 1,
        total: schedule.length,
        block: slot.block,
        position: slot.position,
        runtime: slot.runtime,
      });
      try {
        const runtime = slot.runtime === "node" ? nodeRuntime : bunRuntime;
        assertArtifactSnapshot(
          runtime.artifact,
          await snapshotArtifact(runtime.artifact.root, abortSignal),
          slot.runtime,
        );
        const measured = await runTimed({
          invocation: runtime.invocation,
          env,
          dbPath,
          runDirectory,
          freeBytesFloor: options.freeBytesFloor,
          dbWalByteCap: options.dbWalByteCap,
          abortSignal,
        });
        assertArtifactSnapshot(
          runtime.artifact,
          await snapshotArtifact(runtime.artifact.root, abortSignal),
          slot.runtime,
        );
        const envelope = parseEnvelope(
          measured.stdout,
          "agentmine normalize",
        );
        if (envelope.status !== "success") {
          throw new Error("Agentmine normalize returned a non-success status");
        }
        const normalize = NormalizeDataSchema.parse(envelope.data);
        if (
          normalize.files_scanned !== selection.files.length ||
          normalize.failed !== 0 ||
          normalize.dry_run ||
          !normalize.redacted
        ) {
          throw new Error("Normalize receipt did not match the benchmark fixture");
        }
        const inspection = await inspectDatabase(dbPath);
        throwIfAborted(abortSignal);
        assertNormalizeAccounting(
          normalize,
          inspection.rowCounts,
          selection.files.length,
        );
        const postInspectionSizes = await dbWalBytes(dbPath);
        if (postInspectionSizes.totalBytes > options.dbWalByteCap) {
          throw new SafetyError(
            "database plus WAL exceeded the configured cap during verification",
          );
        }
        const digest = verificationDigest(inspection);
        if (referenceDigest === null) referenceDigest = digest;
        else if (referenceDigest !== digest) {
          throw new Error("Node and Bun produced different fixed query results");
        }
        const cpuSeconds =
          measured.timing.userSeconds + measured.timing.systemSeconds;
        runs.push({
          ordinal: ordinal + 1,
          block: slot.block,
          position: slot.position,
          runtime: slot.runtime,
          wall_seconds: rounded(measured.wallSeconds, 6),
          gnu_wall_seconds: measured.timing.wallSeconds,
          user_seconds: measured.timing.userSeconds,
          system_seconds: measured.timing.systemSeconds,
          cpu_utilization_percent: rounded(
            (cpuSeconds / measured.wallSeconds) * 100,
          ),
          max_rss_bytes: measured.timing.maxRssKib * 1024,
          db_bytes: measured.finalSizes.dbBytes,
          wal_bytes: measured.finalSizes.walBytes,
          db_wal_bytes_peak: measured.peakDbWalBytes,
          db_wal_bytes_after_verification: postInspectionSizes.totalBytes,
          normalize_duration_ms: envelope._meta?.duration_ms ?? null,
          normalize: {
            files_scanned: normalize.files_scanned,
            processed: normalize.processed,
            skipped_empty: normalize.skipped_empty,
            skipped_up_to_date: normalize.skipped_up_to_date,
            skipped_unchanged: normalize.skipped_unchanged,
            skipped_by_filter: normalize.skipped_by_filter,
            failed: normalize.failed,
            redactions: normalize.redactions,
          },
          row_counts: inspection.rowCounts,
          checks: inspection.checks,
          fixed_queries: inspection.fixedQueries,
          verification_sha256: digest,
          stderr_sha256: measured.stderrSha256,
        });
      } finally {
        await rm(runDirectory, { recursive: true, force: true });
      }
      reportProgress("run.done", {
        ordinal: ordinal + 1,
        total: schedule.length,
        runtime: slot.runtime,
      });
    }

    await verifyStagedFixture(staged, abortSignal);
    assertArtifactSnapshot(
      nodeRuntime.artifact,
      await snapshotArtifact(nodeRuntime.artifact.root, abortSignal),
      "node",
    );
    assertArtifactSnapshot(
      bunRuntime.artifact,
      await snapshotArtifact(bunRuntime.artifact.root, abortSignal),
      "bun",
    );
    const summary = summarizeRuns(runs);
    const receipt = {
      version: 1,
      status: "success",
      command: "agentmine benchmark cold-import",
      data: {
        benchmark_version: 2,
        variant: options.variant,
        source: "claude-code",
        scope: "normalize-only",
        cold_definition:
          "Every measurement starts from a new empty database; OS caches are not dropped, and fixture hashing occurs before runs.",
        artifact: {
          directory: roots.runRoot.slice(roots.workRoot.length + 1),
          receipt: "receipt.json",
        },
        fixture: {
          selection_algorithm: "rank-decile-seed-plus-target-average-v1",
          eligible_files: selection.eligibleFiles,
          eligible_bytes: selection.eligibleBytes,
          selected_files: selection.files.length,
          selected_bytes: selection.selectedBytes,
          target_bytes: options.targetBytes,
          cutoff: options.cutoff,
          target_delta_ratio: rounded(selection.targetDeltaRatio, 6),
          unique_file_identity: "session-filename-basename",
          manifest_algorithm: "ordinal-size-content-v1",
          manifest_sha256: staged.manifestSha256,
          tree_manifest_algorithm: "kind-relative-path-size-content-v2",
          tree_manifest_sha256: staged.treeManifestSha256,
          stage_mode: options.stageMode,
          supplemental_files: staged.supplementalFiles,
          supplemental_bytes: staged.supplementalBytes,
          strata: selection.strata,
        },
        schedule: {
          pattern: "ABBA",
          a_runtime: options.aRuntime,
          b_runtime: options.aRuntime === "node" ? "bun" : "node",
          repetitions: options.repetitions,
          total_runs: schedule.length,
          serial: true,
        },
        safety: {
          free_bytes_floor: options.freeBytesFloor,
          default_free_bytes_floor: DEFAULT_FREE_BYTES_FLOOR,
          lowered_free_bytes_floor: options.loweredFreeBytesFloor,
          db_wal_byte_cap: options.dbWalByteCap,
          default_db_wal_byte_cap: DEFAULT_DB_WAL_BYTE_CAP,
          lowered_db_wal_byte_cap: options.loweredDbWalByteCap,
          databases_disposable: true,
        },
        runtimes: {
          node: {
            ...safeRuntimeIdentity(nodeIdentity),
            artifact: publicArtifactSnapshot(nodeRuntime.artifact),
          },
          bun: {
            ...safeRuntimeIdentity(bunIdentity),
            artifact: publicArtifactSnapshot(bunRuntime.artifact),
          },
        },
        runs,
        summary,
        comparison: {
          bun_to_node_wall_median_ratio: rounded(
            summary.bun.wall_seconds_median /
              summary.node.wall_seconds_median,
            4,
          ),
        },
      },
      traceId: randomUUID(),
    };
    assertReceiptDoesNotContainPaths(receipt, sensitivePaths);
    await writeFile(
      join(roots.runRoot, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { mode: 0o600 },
    );
    completed = true;
    return receipt;
  } finally {
    await Promise.all([
      rm(roots.fixture, { recursive: true, force: true }),
      rm(roots.runs, { recursive: true, force: true }),
      rm(roots.home, { recursive: true, force: true }),
      rm(roots.tmp, { recursive: true, force: true }),
    ]);
    if (!completed) {
      await rm(roots.runRoot, { recursive: true, force: true });
    }
  }
}

export function assertReceiptDoesNotContainPaths(receipt, sensitivePaths) {
  const serialized = JSON.stringify(receipt);
  for (const path of sensitivePaths) {
    const encodedPath = path
      ? JSON.stringify(path).slice(1, -1)
      : "";
    if (
      path &&
      (serialized.includes(path) || serialized.includes(encodedPath))
    ) {
      throw new Error("Benchmark receipt contains a private absolute path");
    }
  }
}

function reportProgress(phase, extra = {}) {
  process.stderr.write(
    `${JSON.stringify({ event: "progress", phase, ...extra })}\n`,
  );
}

export function sanitizeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(["'`])\/(?:(?!\1)[\s\S])*?\1/gu, "$1<path>$1")
    .replace(/(?:\/[^\s\/"'`<>()[\]{},;:]+)+/gu, "<path>");
}

function terminateActiveProcessGroups(signal) {
  for (const pid of activeProcessGroups) {
    try {
      terminateProcessGroup(pid, signal);
    } catch {
      // A second signal still hard-stops the harness if a child cannot be found.
    }
  }
}

export function createSignalHandler(
  controller,
  terminate = terminateActiveProcessGroups,
  hardExit = (code) => process.exit(code),
) {
  let receivedSignals = 0;
  return (signal) => {
    receivedSignals += 1;
    if (receivedSignals === 1) {
      controller.abort(new BenchmarkInterruptedError(signal));
      terminate("SIGTERM");
      return;
    }
    terminate("SIGKILL");
    hardExit(signal === "SIGINT" ? 130 : 143);
  };
}

function installSignalHandlers(controller) {
  const handlers = new Map();
  const handleSignal = createSignalHandler(controller);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => handleSignal(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}

function errorContract(error) {
  if (error instanceof UsageError) {
    return {
      code: ERROR_CODES.VALIDATION_ERROR,
      name: "VALIDATION_ERROR",
      category: "user",
      retryable: false,
      exitCode: 2,
    };
  }
  if (error instanceof BenchmarkInterruptedError) {
    return {
      code: ERROR_CODES.BENCHMARK_INTERRUPTED,
      name: "BENCHMARK_INTERRUPTED",
      category: "transient",
      retryable: true,
      exitCode: 4,
    };
  }
  if (error instanceof SafetyError) {
    return {
      code: ERROR_CODES.SAFETY_LIMIT,
      name: "SAFETY_LIMIT",
      category: "transient",
      retryable: true,
      exitCode: 4,
    };
  }
  return {
    code: ERROR_CODES.BENCHMARK_FAILED,
    name: "BENCHMARK_FAILED",
    category: "system",
    retryable: false,
    exitCode: 3,
  };
}

async function main(abortSignal) {
  const options = parseArgs(process.argv.slice(2));
  const receipt = await executeBenchmark(options, abortSignal);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const removeSignalHandlers = installSignalHandlers(controller);
  try {
    await main(controller.signal);
  } catch (error) {
    const contract = errorContract(error);
    process.stdout.write(
      `${JSON.stringify({
        version: 1,
        status: "error",
        command: "agentmine benchmark cold-import",
        data: null,
        errors: [
          {
            code: contract.code,
            name: contract.name,
            message: sanitizeErrorMessage(error),
            category: contract.category,
            retryable: contract.retryable,
          },
        ],
        traceId: randomUUID(),
      })}\n`,
    );
    process.exitCode = contract.exitCode;
  } finally {
    removeSignalHandlers();
  }
}
