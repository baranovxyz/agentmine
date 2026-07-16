#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const entrySchema = z
  .object({
    path: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    size: z.number().int().nonnegative(),
    executable: z.boolean(),
  })
  .strict();

const manifestSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("sha256"),
    root: z.literal("dist"),
    files: z.array(entrySchema).min(1),
  })
  .strict();

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateRelativeArtifactPath(path) {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    /[\p{Cc}\p{Cf}]/u.test(path) ||
    /^[A-Za-z]:/u.test(path) ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`invalid artifact path: ${JSON.stringify(path)}`);
  }
}

async function readJsonValidated(path, schema) {
  const pathStat = await lstat(path);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error(`manifest must be a regular file: ${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${path}: ${detail}`, { cause: error });
  }
  return schema.parse(parsed);
}

async function collectEntries(rootDir, currentDir, prefix) {
  const entries = [];
  for (const dirent of await readdir(currentDir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    validateRelativeArtifactPath(relativePath);
    const absolutePath = join(rootDir, ...relativePath.split("/"));
    const fileStat = await lstat(absolutePath);
    if (fileStat.isSymbolicLink()) {
      throw new Error(`artifact must not be a symbolic link: ${relativePath}`);
    }
    if (fileStat.isDirectory()) {
      entries.push(...(await collectEntries(rootDir, absolutePath, relativePath)));
      continue;
    }
    if (!fileStat.isFile()) {
      throw new Error(`artifact must be a regular file: ${relativePath}`);
    }
    const bytes = await readFile(absolutePath);
    entries.push({
      path: relativePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      executable: (fileStat.mode & 0o111) !== 0,
    });
  }
  return entries.sort((left, right) => comparePaths(left.path, right.path));
}

function validateManifestPaths(files) {
  const foldedPaths = new Set();
  let previous;
  for (const file of files) {
    validateRelativeArtifactPath(file.path);
    if (previous !== undefined && comparePaths(previous, file.path) >= 0) {
      throw new Error("manifest file entries must be strictly sorted by path");
    }
    previous = file.path;
    const folded = file.path.toLowerCase();
    if (foldedPaths.has(folded)) {
      throw new Error(`manifest paths collide case-insensitively: ${file.path}`);
    }
    foldedPaths.add(folded);
  }
}

export async function verifyDistManifest({ packageRoot, manifestPath }) {
  const manifest = await readJsonValidated(manifestPath, manifestSchema);
  validateManifestPaths(manifest.files);

  const distDir = join(packageRoot, manifest.root);
  const distStat = await lstat(distDir);
  if (distStat.isSymbolicLink() || !distStat.isDirectory()) {
    throw new Error("artifact root must be a regular directory");
  }
  const actualFiles = await collectEntries(distDir, distDir, "");
  if (actualFiles.length === 0) throw new Error("artifact root must not be empty");

  const expectedPaths = manifest.files.map((entry) => entry.path);
  const actualPaths = actualFiles.map((entry) => entry.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const expected = new Set(expectedPaths);
    const actual = new Set(actualPaths);
    const missing = expectedPaths.filter((path) => !actual.has(path));
    const extra = actualPaths.filter((path) => !expected.has(path));
    throw new Error(
      `artifact file set mismatch (missing: ${missing.join(", ") || "none"}; ` +
        `extra: ${extra.join(", ") || "none"})`,
    );
  }

  for (let index = 0; index < manifest.files.length; index += 1) {
    const expected = manifest.files[index];
    const actual = actualFiles[index];
    if (expected.sha256 !== actual.sha256) {
      throw new Error(`artifact sha256 mismatch: ${expected.path}`);
    }
    if (expected.size !== actual.size) {
      throw new Error(`artifact size mismatch: ${expected.path}`);
    }
    if (expected.executable !== actual.executable) {
      throw new Error(`artifact executable-bit mismatch: ${expected.path}`);
    }
  }

  return { files: actualFiles.length };
}

function parseArgs(args) {
  const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
  let packageRoot = defaultRoot;
  let manifestPath;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--package-root" && arg !== "--manifest") {
      throw new Error(
        "usage: verify-dist-manifest.mjs [--package-root <dir>] [--manifest <file>]",
      );
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    if (arg === "--package-root") packageRoot = resolve(value);
    else manifestPath = resolve(value);
    index += 1;
  }
  return {
    packageRoot,
    manifestPath: manifestPath ?? join(packageRoot, "dist-manifest.json"),
  };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await verifyDistManifest(options);
    console.log(`Verified ${result.files} dist file(s) against the reviewed artifact manifest.`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Agentmine dist-manifest verification failed: ${detail}`);
    process.exitCode = 1;
  }
}
