import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VERIFIER = join(REPO, "scripts", "verify-dist-manifest.mjs");

interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
}

let root: string;
let dist: string;
let manifestPath: string;

async function entry(path: string): Promise<ManifestEntry> {
  const absolute = join(dist, ...path.split("/"));
  const [bytes, fileStat] = await Promise.all([
    readFile(absolute),
    lstat(absolute),
  ]);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    executable: (fileStat.mode & 0o111) !== 0,
  };
}

async function writeManifest(
  files: ManifestEntry[],
  extra = {},
): Promise<void> {
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      algorithm: "sha256",
      root: "dist",
      files,
      ...extra,
    })}\n`,
  );
}

async function verify() {
  return execa(
    "node",
    [VERIFIER, "--package-root", root, "--manifest", manifestPath],
    { reject: false },
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentmine-dist-manifest-"));
  dist = join(root, "dist");
  manifestPath = join(root, "reviewed-manifest.json");
  await mkdir(dist);
  await writeFile(join(dist, "cli.js"), "#!/usr/bin/env node\nexport {};\n");
  await writeFile(join(dist, "lib.js"), "export const value = 1;\n");
  await chmod(join(dist, "cli.js"), 0o755);
  await chmod(join(dist, "lib.js"), 0o644);
  await writeManifest(await Promise.all([entry("cli.js"), entry("lib.js")]));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("reviewed dist manifest", () => {
  it("accepts the exact file set, hashes, sizes, and executable bits", async () => {
    const result = await verify();

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Verified 2 dist file(s)");
  });

  it("rejects changed bytes", async () => {
    await writeFile(join(dist, "lib.js"), "export const value = 2;\n");

    const result = await verify();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("artifact sha256 mismatch: lib.js");
  });

  it("rejects an extra dist file", async () => {
    await writeFile(join(dist, "extra.js"), "export {};\n");

    const result = await verify();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("extra: extra.js");
  });

  it("rejects a missing dist file", async () => {
    await rm(join(dist, "lib.js"));

    const result = await verify();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing: lib.js");
  });

  it("rejects executable-bit drift", async () => {
    await chmod(join(dist, "lib.js"), 0o755);

    const result = await verify();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("artifact executable-bit mismatch: lib.js");
  });

  it("rejects symbolic links", async () => {
    await symlink("lib.js", join(dist, "linked.js"));

    const result = await verify();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "artifact must not be a symbolic link: linked.js",
    );
  });

  it.each([
    "../cli.js",
    "/cli.js",
    "C:/cli.js",
    "cli\\evil.js",
    "cli\t.js",
  ])("rejects unsafe manifest path %j", async (path) => {
    const valid = await entry("cli.js");
    await writeManifest([{ ...valid, path }]);

    const result = await verify();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid artifact path");
  });

  it("rejects unsorted and case-colliding manifest entries", async () => {
    const [cli, lib] = await Promise.all([entry("cli.js"), entry("lib.js")]);
    await writeManifest([lib, cli]);
    expect((await verify()).stderr).toContain("strictly sorted");

    await writeManifest([{ ...lib, path: "CLI.JS" }, cli]);
    expect((await verify()).stderr).toContain("collide case-insensitively");
  });

  it("rejects provenance-shaped extra manifest metadata", async () => {
    const files = await Promise.all([entry("cli.js"), entry("lib.js")]);
    await writeManifest(files, { sourceRevision: "aaaaaaaa" });

    const result = await verify();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unrecognized key");
  });
});
