import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { Database } from "../src/db/sqlite.js";
import { VERSION } from "../src/version.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);
const BUN_BIN = join(REPO, "node_modules", ".bin", "bun");
const BUILD_SCRIPT = join(REPO, "scripts", "build-standalone.mjs");
const CLINE_FIXTURE_DIR = join(__dirname, "fixtures", "cline", "fixture-001");
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function hostTarget(): string | undefined {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "bun-darwin-arm64";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "bun-darwin-x64";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "bun-linux-x64-baseline";
  }
  return undefined;
}

const runStandalone = process.env.AGENTMINE_RUN_STANDALONE_E2E === "1";

describe.runIf(runStandalone)("standalone executable", () => {
  it("builds and runs the full local workflow with extensions and SQLite", async () => {
    const target = hostTarget();
    if (!target) {
      throw new Error(
        `Unsupported standalone smoke-test host: ${process.platform}-${process.arch}`,
      );
    }

    const dir = mkdtempSync(join(tmpdir(), "agentmine-standalone-"));
    const externalBinary = process.env.AGENTMINE_STANDALONE_BINARY;
    const binary = externalBinary
      ? resolve(externalBinary)
      : join(dir, "agentmine");
    const sourceCommit =
      process.env.AGENTMINE_STANDALONE_SOURCE_COMMIT ?? SOURCE_COMMIT;
    const expectedTarget = process.env.AGENTMINE_STANDALONE_TARGET ?? target;
    expect(expectedTarget).toBe(target);
    const home = join(dir, "home");
    const dataRoot = join(dir, "data");
    const clineSessionsDir = join(dir, "cline-sessions");
    const sourceDir = join(clineSessionsDir, "fixture-001");
    const dbPath = join(dir, "sessions.db");
    const backupPath = join(dir, "backup.tar.gz");
    let fixtureServer: Server | undefined;

    try {
      if (!externalBinary) {
        const build = await execa(
          BUN_BIN,
          [
            BUILD_SCRIPT,
            "--target",
            target,
            "--outfile",
            binary,
            "--source-commit",
            sourceCommit,
          ],
          { cwd: REPO },
        );
        const buildResult = JSON.parse(build.stdout.trim());
        expect(buildResult).toMatchObject({
          version: 1,
          status: "success",
          command: "agentmine build-standalone",
          data: {
            agentmine_version: VERSION,
            target,
            outfile: binary,
            source_commit: sourceCommit,
          },
        });
        expect(buildResult.data.size).toBeGreaterThan(0);
        expect(buildResult.data.sha256).toMatch(/^[0-9a-f]{64}$/u);
      }
      expect(existsSync(binary)).toBe(true);

      const baseEnv = {
        ...process.env,
        NO_COLOR: "1",
        HOME: home,
        XDG_DATA_HOME: dataRoot,
        CLINE_SESSION_DATA_DIR: clineSessionsDir,
        AGENTMINE_DB: dbPath,
      };
      const runBinary = (
        args: string[],
        extraEnv: Record<string, string> = {},
      ) =>
        execa(binary, args, {
          cwd: dir,
          env: { ...baseEnv, ...extraEnv },
          reject: false,
        });

      const [plain, version, schema] = await Promise.all([
        runBinary(["--version"]),
        runBinary(["version"]),
        runBinary(["schema"]),
      ]);
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout.trim()).toBe(VERSION);

      const versionResult = JSON.parse(version.stdout.trim());
      expect(versionResult).toMatchObject({
        status: "success",
        command: "agentmine version",
        data: {
          agentmine_version: VERSION,
          runtime: "bun-standalone",
          target,
          bun_version: "1.3.14",
          source_commit: sourceCommit,
        },
      });
      expect(versionResult.data.runtime_version).toBe("1.3.14");

      const schemaResult = JSON.parse(schema.stdout.trim());
      expect(schemaResult.status).toBe("success");
      expect(schemaResult.data.commands.version).toBeTruthy();

      mkdirSync(sourceDir, { recursive: true });
      for (const name of [
        "fixture-001.messages.json",
        "fixture-001.json",
        "subagent-placeholder.messages.json",
        "team-agent-placeholder__task-placeholder.messages.json",
      ]) {
        copyFileSync(join(CLINE_FIXTURE_DIR, name), join(sourceDir, name));
      }
      const extensionDir = join(home, ".config", "agentmine");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        join(extensionDir, "extensions.js"),
        [
          "export default {",
          "  redactPatterns: [{",
          '    name: "standalone-extension",',
          "    pattern: /sample project/giu,",
          '    replace: () => "[standalone-extension-redacted]",',
          "  }],",
          "};",
          "",
        ].join("\n"),
      );

      const ingest = await runBinary(["ingest", "--source", "cline"]);
      expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);
      expect(JSON.parse(ingest.stdout.trim())).toMatchObject({
        status: "success",
        command: "agentmine ingest",
      });

      const db = new Database(dbPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const messages = db
          .prepare<[], { text: string }>(
            "SELECT text FROM messages ORDER BY session_id, turn",
          )
          .all()
          .map((row) => row.text)
          .join("\n");
        expect(messages).toContain("[standalone-extension-redacted]");
        expect(messages).not.toContain("sample project");
      } finally {
        db.close();
      }

      const prices = await runBinary(["prices", "sync"]);
      expect(prices.exitCode, `${prices.stdout}\n${prices.stderr}`).toBe(0);
      expect(JSON.parse(prices.stdout.trim())).toMatchObject({
        status: "success",
        command: "agentmine prices sync",
        data: { source: "snapshot" },
      });

      fixtureServer = createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/embed" && request.method === "POST") {
          response.end(
            JSON.stringify({
              embeddings: [
                Array.from({ length: 768 }, (_, index) =>
                  index === 0 ? 1 : 0,
                ),
              ],
            }),
          );
          return;
        }
        if (request.url === "/prices" && request.method === "GET") {
          response.end(
            JSON.stringify({
              "model-placeholder": {
                input_cost_per_token: 0.000001,
                output_cost_per_token: 0.000002,
              },
            }),
          );
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      });
      await new Promise<void>((resolvePromise, reject) => {
        fixtureServer?.once("error", reject);
        fixtureServer?.listen(0, "127.0.0.1", resolvePromise);
      });
      const fixtureAddress = fixtureServer.address() as AddressInfo;
      const fixtureBaseUrl = `http://127.0.0.1:${fixtureAddress.port}`;

      const embed = await runBinary(
        [
          "embed",
          "--provider",
          "ollama",
          "--model",
          "nomic-embed-text",
          "--limit",
          "100",
        ],
        { AGENTMINE_OLLAMA_BASE_URL: fixtureBaseUrl },
      );
      expect(embed.exitCode, `${embed.stdout}\n${embed.stderr}`).toBe(0);
      expect(JSON.parse(embed.stdout.trim())).toMatchObject({
        command: "agentmine embed",
        data: {
          provider: "ollama",
          model: "nomic-embed-text",
        },
      });
      expect(
        JSON.parse(embed.stdout.trim()).data.embedded_chunks,
      ).toBeGreaterThan(0);

      const onlinePrices = await runBinary(["prices", "sync", "--online"], {
        AGENTMINE_LITELLM_PRICE_URL: `${fixtureBaseUrl}/prices`,
      });
      expect(
        onlinePrices.exitCode,
        `${onlinePrices.stdout}\n${onlinePrices.stderr}`,
      ).toBe(0);
      expect(JSON.parse(onlinePrices.stdout.trim())).toMatchObject({
        command: "agentmine prices sync",
        data: {
          source: "litellm",
          priced: 1,
        },
      });

      const backup = await runBinary(["backup", "--output", backupPath]);
      expect(backup.exitCode, `${backup.stdout}\n${backup.stderr}`).toBe(0);
      expect(existsSync(backupPath)).toBe(true);
      expect(readFileSync(backupPath).byteLength).toBeGreaterThan(0);
    } finally {
      if (fixtureServer) {
        await new Promise<void>((resolvePromise, reject) => {
          fixtureServer?.close((error) => {
            if (error) reject(error);
            else resolvePromise();
          });
        });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
