import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

// Guards the published artifact, not source-mode execution. Building, packing,
// and loading the extracted files catches bundler and package-allowlist defects
// that source-mode tests cannot observe.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);
const WORKSPACE = join(REPO, "..", "..");
const IN_WORKSPACE = existsSync(join(WORKSPACE, "pnpm-workspace.yaml"));

const manifestSchema = z
  .object({
    name: z.literal("agentmine"),
    bin: z.object({ agentmine: z.literal("./dist/cli.js") }),
    files: z.array(z.string()),
    keywords: z.array(z.string()),
  })
  .passthrough();

const schemaEnvelopeSchema = z
  .object({
    status: z.literal("success"),
    data: z
      .object({
        commands: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();

let tempDir: string | undefined;
let packageDir: string;

function parseJsonValidated<T>(
  source: string,
  label: string,
  schema: z.ZodType<T>,
): T {
  try {
    const parsed: unknown = JSON.parse(source);
    return schema.parse(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON from ${label}: ${detail}`, { cause: error });
  }
}

async function readJsonValidated<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  return parseJsonValidated(await readFile(path, "utf8"), path, schema);
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function parseUsageCommands(help: string): string[] {
  const usage = help.match(/^USAGE agentmine (.+)$/mu)?.[1];
  if (usage === undefined) throw new Error("Missing root command usage line");
  return usage.split("|").map((command) => command.trim());
}

beforeAll(async () => {
  if (IN_WORKSPACE) {
    const canonicalDist = join(
      WORKSPACE,
      "packages",
      "agent-canonical",
      "dist",
    );
    if (!existsSync(canonicalDist)) {
      await execa("pnpm", ["--filter", "agent-canonical", "build"], {
        cwd: WORKSPACE,
      });
    }
    await execa("pnpm", ["--filter", "agentmine", "build"], {
      cwd: WORKSPACE,
    });
  } else {
    await execa("pnpm", ["build"], { cwd: REPO });
  }

  // Extract below the package root so the isolated artifact can resolve the
  // production dependencies installed in this checkout without network access.
  tempDir = await mkdtemp(join(REPO, ".artifact-test-"));
  const packed = await execa(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", tempDir],
    { cwd: REPO },
  );
  const tarballName = packed.stdout.trim().split("\n").at(-1);
  if (!tarballName) throw new Error("npm pack did not report a tarball name");

  const extractDir = join(tempDir, "extract");
  await mkdir(extractDir);
  await execa("tar", ["-xzf", join(tempDir, tarballName), "-C", extractDir]);
  packageDir = join(extractDir, "package");
}, 180_000);

afterAll(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("published package artifact", () => {
  it("loads the extracted CLI and library", async () => {
    if (tempDir === undefined)
      throw new Error("artifact temp directory missing");
    const cliPath = join(packageDir, "dist", "cli.js");
    const isolatedEnv = {
      ...process.env,
      NO_COLOR: "1",
      HOME: tempDir,
      XDG_DATA_HOME: join(tempDir, "data"),
      AGENTMINE_DB: join(tempDir, "sessions.db"),
    };
    const { exitCode, stderr, stdout } = await execa(
      "node",
      [cliPath, "schema"],
      {
        reject: false,
        env: isolatedEnv,
      },
    );
    expect(exitCode, stderr).toBe(0);
    expect(stderr).toBe("");
    const schema = parseJsonValidated(
      stdout.trim(),
      "agentmine schema",
      schemaEnvelopeSchema,
    );
    expect(schema.status).toBe("success");

    const help = await execa("node", [cliPath, "--help"], {
      reject: false,
      env: isolatedEnv,
    });
    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stderr).toBe("");
    expect(Object.keys(schema.data.commands).sort()).toEqual(
      parseUsageCommands(help.stdout).sort(),
    );

    const version = await execa("node", [cliPath, "--version"], {
      reject: false,
      env: isolatedEnv,
    });
    expect(version.exitCode, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe("0.3.0");
    expect(version.stderr).toBe("");

    const forwardedWarning = await execa(
      "node",
      [
        "--import",
        'data:text/javascript,process.emitWarning("forwarded warning",{type:"AgentmineTestWarning"})',
        cliPath,
        "--version",
      ],
      {
        reject: false,
        env: isolatedEnv,
      },
    );
    expect(forwardedWarning.exitCode, forwardedWarning.stderr).toBe(0);
    expect(forwardedWarning.stdout.trim()).toBe("0.3.0");
    expect(forwardedWarning.stderr).toContain(
      "AgentmineTestWarning: forwarded warning",
    );
    expect(forwardedWarning.stderr).not.toContain(
      "SQLite is an experimental feature",
    );

    const library = await import(
      pathToFileURL(join(packageDir, "dist", "lib.js")).href
    );
    expect(Object.keys(library).sort()).toEqual([
      "parseClaudeCodeFile",
      "parseCursorFile",
      "walkJsonl",
    ]);
  }, 30_000);

  it("packs the documented public files and executable", async () => {
    const manifest = await readJsonValidated(
      join(packageDir, "package.json"),
      manifestSchema,
    );
    expect(manifest.name).toBe("agentmine");
    expect(manifest.files).not.toContain("dist-manifest.json");
    expect(manifest.keywords).toContain("gemini");
    expect(manifest.keywords).toContain("qwen");
    expect(manifest.keywords).toContain("kilo-code");
    expect(manifest.keywords).toContain("goose");
    expect(manifest.keywords).toContain("cline");

    const files = (await collectFiles(packageDir)).map((path) =>
      relative(packageDir, path),
    );
    for (const required of [
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "dist/cli.js",
      "dist/lib.js",
      "guide/getting-started.md",
      "guide/reference/cli.md",
    ]) {
      expect(files).toContain(required);
    }
    expect(files.some((path) => path.endsWith(".map"))).toBe(false);
    expect(files.some((path) => path.startsWith("tests/"))).toBe(false);

    const cliStat = await stat(join(packageDir, "dist", "cli.js"));
    expect(cliStat.mode & 0o111).not.toBe(0);
  });

  it("documents Gemini, Qwen, Kilo, Goose, and Cline in packed public entry points", async () => {
    const publicDocs = await Promise.all(
      ["README.md", "CHANGELOG.md", "guide/getting-started.md"].map((path) =>
        readFile(join(packageDir, path), "utf8"),
      ),
    );

    for (const document of publicDocs) {
      expect(document).toMatch(/Gemini/u);
      expect(document).toMatch(/Qwen/u);
      expect(document).toMatch(/Kilo/u);
      expect(document).toMatch(/Goose/u);
      expect(document).toMatch(/Cline/u);
    }
    expect(publicDocs[0]).toContain("agentmine ingest --source gemini");
    expect(publicDocs[0]).toContain("agentmine ingest --source qwen");
    expect(publicDocs[0]).toContain("agentmine normalize --source kilo");
    expect(publicDocs[0]).toContain("agentmine normalize --source goose");
    expect(publicDocs[0]).toContain("agentmine ingest --source cline");
  });

  it("documents unredacted workflow surfaces in the packed privacy guide", async () => {
    const guide = await readFile(
      join(packageDir, "guide", "guides", "redaction.md"),
      "utf8",
    );
    for (const surface of [
      "raw_workflow_runs.raw_json",
      "raw_workflow_runs.raw_path",
      "raw_workflow_journal.raw_json",
      "workflow_agents.result_preview",
      "workflow_agents.result_full",
      "agentmine workflow",
    ]) {
      expect(guide).toContain(surface);
    }
  });

  it("keeps relative Markdown links inside the package", async () => {
    const markdownFiles = (await collectFiles(packageDir)).filter((path) =>
      path.endsWith(".md"),
    );

    for (const markdownPath of markdownFiles) {
      const markdown = await readFile(markdownPath, "utf8");
      const targets = [...markdown.matchAll(/\]\(([^)]+)\)/gu)]
        .map((match) => match[1])
        .filter((target): target is string => target !== undefined)
        .filter(
          (target) =>
            !target.startsWith("http://") &&
            !target.startsWith("https://") &&
            !target.startsWith("#") &&
            !target.startsWith("mailto:"),
        )
        .map((target) => target.split(/[?#]/u, 1)[0])
        .filter(
          (target): target is string => target !== undefined && target !== "",
        );

      for (const target of new Set(targets)) {
        expect(
          target,
          `${relative(packageDir, markdownPath)} uses a root-relative link`,
        ).not.toMatch(/^\//u);
        await expect(
          stat(join(dirname(markdownPath), target)),
          `${relative(packageDir, markdownPath)} -> ${target}`,
        ).resolves.toMatchObject({});
      }
    }
  });
});
