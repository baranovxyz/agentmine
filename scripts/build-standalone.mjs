#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const TARGETS = new Set([
  "bun-linux-x64-baseline",
  "bun-darwin-x64",
  "bun-darwin-arm64",
]);

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    target: undefined,
    outfile: undefined,
    sourceCommit: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--target" && value !== undefined) {
      options.target = value;
      index += 1;
    } else if (arg === "--outfile" && value !== undefined) {
      options.outfile = value;
      index += 1;
    } else if (arg === "--source-commit" && value !== undefined) {
      options.sourceCommit = value;
      index += 1;
    } else {
      throw new UsageError(`Unknown or incomplete argument: ${arg ?? ""}`);
    }
  }

  if (!options.target || !TARGETS.has(options.target)) {
    throw new UsageError(
      `--target must be one of: ${[...TARGETS].join(", ")}`,
    );
  }
  if (!options.outfile) {
    throw new UsageError("--outfile is required");
  }
  if (
    options.sourceCommit !== undefined &&
    !/^[0-9a-f]{40}$/u.test(options.sourceCommit)
  ) {
    throw new UsageError(
      "--source-commit must be a lowercase 40-character Git SHA",
    );
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageRoot = resolve(import.meta.dir, "..");
  const outfile = resolve(process.cwd(), options.outfile);
  await mkdir(dirname(outfile), { recursive: true });

  const packageJson = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  );
  const result = await Bun.build({
    entrypoints: [resolve(packageRoot, "src", "cli.ts")],
    compile: {
      target: options.target,
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    define: {
      AGENTMINE_BUILD_TARGET: JSON.stringify(options.target),
      AGENTMINE_BUILD_BUN_VERSION: JSON.stringify(Bun.version),
      AGENTMINE_BUILD_SOURCE_COMMIT: JSON.stringify(
        options.sourceCommit ?? null,
      ),
    },
    minify: true,
  });

  if (!result.success) {
    throw new Error(
      result.logs.map((entry) => entry.message).join("\n") ||
        "Bun build failed without diagnostics",
    );
  }

  const bytes = await readFile(outfile);
  const metadata = await stat(outfile);
  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      status: "success",
      command: "agentmine build-standalone",
      data: {
        agentmine_version: packageJson.version,
        target: options.target,
        outfile,
        size: metadata.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bun_version: Bun.version,
        source_commit: options.sourceCommit ?? null,
      },
      traceId: randomUUID(),
    })}\n`,
  );
}

try {
  await main();
} catch (error) {
  const usage = error instanceof UsageError;
  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      status: "error",
      command: "agentmine build-standalone",
      data: null,
      errors: [
        {
          code: usage ? 1000 : 2000,
          name: usage ? "VALIDATION_ERROR" : "BUILD_FAILED",
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
