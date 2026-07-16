import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);
const TSX_BIN = join(REPO, "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(REPO, "src", "cli.ts");

it("skips live sockets while syncing Cursor transcripts", async () => {
  // Keep the fixture below macOS's short AF_UNIX path limit.
  const dir = mkdtempSync(join(tmpdir(), "am-"));
  const home = join(dir, "h");
  const sourceDir = join(home, ".cursor", "projects", "p");
  const dataDir = join(dir, "d");
  const socketPath = join(sourceDir, "worker.sock");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "session.jsonl"), "{}\n");

  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });

    const { exitCode, stdout } = await execa(
      TSX_BIN,
      [CLI_ENTRY, "sync", "--source", "cursor"],
      {
        cwd: REPO,
        reject: false,
        env: {
          ...process.env,
          HOME: home,
          NO_COLOR: "1",
          XDG_DATA_HOME: dataDir,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.status).toBe("success");
    expect(parsed.command).toBe("agentmine sync");
    expect(parsed.data.results).toMatchObject([
      { status: "synced", exitCode: 0 },
    ]);

    const targetDir = join(dataDir, "agentmine", "sessions", "cursor", "p");
    expect(existsSync(join(targetDir, "session.jsonl"))).toBe(true);
    expect(existsSync(join(targetDir, "worker.sock"))).toBe(false);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
