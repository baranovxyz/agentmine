import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { defineCommand } from "citty";
import { getDbPath, paths } from "../config.js";
import { Errors } from "../contract/errors.js";
import {
  reportProgress,
  reportProgressImmediate,
} from "../contract/progress.js";
import { runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";
import { Database } from "../db/sqlite.js";

export const backupCommand = defineCommand({
  meta: {
    name: "backup",
    description: "Create a consistent tar.gz backup of sessions.db",
  },
  args: {
    output: {
      type: "string",
      description:
        "Archive path to write (default: <app-data>/sessions/backups/sessions-YYYY-MM-DD.tar.gz)",
    },
    force: {
      type: "boolean",
      default: false,
      description: "Overwrite the output archive if it already exists",
    },
  },
  async run({ args }) {
    await runCommand({
      command: "agentmine backup",
      handler: async () => {
        const dbPath = getDbPath();
        if (!dbExists(dbPath)) {
          throw Errors.notFound(
            `sessions.db not found at ${dbPath}. Run \`agentmine normalize\` first.`,
          );
        }

        const archivePath = resolveOutputPath(args.output);
        const force = Boolean(args.force);
        if (existsSync(archivePath) && !force) {
          throw Errors.invalidInput(
            `Backup archive already exists: ${archivePath}. Pass --force to overwrite it.`,
            "output",
          );
        }

        await mkdir(dirname(archivePath), { recursive: true });
        const workDir = await mkdtemp(join(tmpdir(), "agentmine-backup-"));
        const snapshotPath = join(workDir, "sessions.db");
        const manifestPath = join(workDir, "manifest.json");

        reportProgressImmediate("backup.start", {
          db_path: dbPath,
          archive_path: archivePath,
        });
        try {
          await createSqliteSnapshot(dbPath, snapshotPath);
          const integrityCheck = verifyIntegrity(snapshotPath);
          if (integrityCheck !== "ok") {
            throw Errors.dbError(
              `Backup integrity check failed: ${integrityCheck}`,
            );
          }

          const snapshotStat = await stat(snapshotPath);
          const manifest = {
            created_at: new Date().toISOString(),
            db_path: dbPath,
            snapshot_file: basename(snapshotPath),
            integrity_check: integrityCheck,
            snapshot_size_bytes: snapshotStat.size,
          };
          await writeFile(
            manifestPath,
            JSON.stringify(manifest, null, 2) + "\n",
            "utf8",
          );

          if (force) await rm(archivePath, { force: true });
          await createTarGz(workDir, archivePath, [
            "sessions.db",
            "manifest.json",
          ]);
          const archiveStat = await stat(archivePath);
          reportProgressImmediate("backup.done", {
            archive_path: archivePath,
            size_bytes: archiveStat.size,
          });

          return {
            data: {
              archive_path: archivePath,
              db_path: dbPath,
              size_bytes: archiveStat.size,
              snapshot_size_bytes: snapshotStat.size,
              integrity_check: integrityCheck,
              included_files: ["sessions.db", "manifest.json"],
            },
          };
        } finally {
          await rm(workDir, { recursive: true, force: true });
        }
      },
    });
  },
});

function resolveOutputPath(value: unknown): string {
  if (value) return resolve(String(value));
  return join(paths.backups, `sessions-${formatLocalDate(new Date())}.tar.gz`);
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function createSqliteSnapshot(
  dbPath: string,
  snapshotPath: string,
): Promise<void> {
  const db = openDb({
    readonly: true,
    init: false,
    path: dbPath,
  });
  try {
    await db.backup(snapshotPath, {
      progress({ totalPages, remainingPages }) {
        reportProgress("backup.copy", {
          current: totalPages - remainingPages,
          total: totalPages,
          remaining_pages: remainingPages,
        });
        return 100;
      },
    });
  } finally {
    db.close();
  }
}

function verifyIntegrity(snapshotPath: string): string {
  const db = new Database(snapshotPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const result = db.pragma("integrity_check", { simple: true });
    return typeof result === "string" ? result : JSON.stringify(result);
  } finally {
    db.close();
  }
}

function createTarGz(
  cwd: string,
  archivePath: string,
  files: string[],
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tar", ["-czf", archivePath, "-C", cwd, ...files], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        Errors.ioError(
          `tar backup archive creation failed (exit ${code}): ${stderr.slice(0, 500)}`,
        ),
      );
    });
  });
}
