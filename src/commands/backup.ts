import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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
import { archivePath, corpusLayout } from "../db/archives.js";
import { dbExists, openDb } from "../db/client.js";
import { lockPathFor, withWriteLock } from "../db/lock.js";
import { Database } from "../db/sqlite.js";

interface SnapshotSource {
  sourcePath: string;
  snapshotFile: string;
}

interface SnapshotReceipt {
  source_path: string;
  snapshot_file: string;
  size_bytes: number;
  integrity_check: string;
}

export const backupCommand = defineCommand({
  meta: {
    name: "backup",
    description: "Create a consistent tar.gz backup of the SQLite corpus",
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

        return await withWriteLock(
          { command: "agentmine backup", dbPath },
          async () => createBackup(dbPath, args.output, Boolean(args.force)),
        );
      },
    });
  },
});

async function createBackup(
  dbPath: string,
  output: unknown,
  force: boolean,
): Promise<{ data: Record<string, unknown> }> {
  const outputPath = resolveOutputPath(output);
  const resolvedDbPath = resolve(dbPath);
  const corpusPaths = [
    resolvedDbPath,
    archivePath("raw", resolvedDbPath),
    archivePath("tools", resolvedDbPath),
  ];
  const protectedCorpusPaths = new Set<string>();
  for (const corpusPath of corpusPaths) {
    for (const candidate of [
      corpusPath,
      `${corpusPath}-wal`,
      `${corpusPath}-shm`,
    ]) {
      protectedCorpusPaths.add(canonicalPath(candidate));
    }
    const canonicalCorpusPath = canonicalPath(corpusPath);
    protectedCorpusPaths.add(canonicalCorpusPath);
    protectedCorpusPaths.add(canonicalPath(`${canonicalCorpusPath}-wal`));
    protectedCorpusPaths.add(canonicalPath(`${canonicalCorpusPath}-shm`));
  }
  protectedCorpusPaths.add(canonicalPath(lockPathFor(resolvedDbPath)));
  if (protectedCorpusPaths.has(canonicalPath(outputPath))) {
    throw Errors.invalidInput(
      `Backup output must not overwrite a corpus database: ${outputPath}.`,
      "output",
    );
  }
  if (existsSync(outputPath) && !force) {
    throw Errors.invalidInput(
      `Backup archive already exists: ${outputPath}. Pass --force to overwrite it.`,
      "output",
    );
  }

  const { layout, sources } = inspectCorpus(resolvedDbPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const workDir = await mkdtemp(join(tmpdir(), "agentmine-backup-"));
  const manifestPath = join(workDir, "manifest.json");

  reportProgressImmediate("backup.start", {
    db_path: resolvedDbPath,
    archive_path: outputPath,
    corpus_layout: layout,
    database_count: sources.length,
  });
  try {
    const snapshots: SnapshotReceipt[] = [];
    for (const source of sources) {
      const snapshotPath = join(workDir, source.snapshotFile);
      await createSqliteSnapshot(source.sourcePath, snapshotPath);
      const integrityCheck = verifyIntegrity(snapshotPath);
      if (integrityCheck !== "ok") {
        throw Errors.dbError(
          `Backup integrity check failed for ${source.snapshotFile}: ${integrityCheck}`,
        );
      }
      const snapshotStat = await stat(snapshotPath);
      snapshots.push({
        source_path: source.sourcePath,
        snapshot_file: source.snapshotFile,
        size_bytes: snapshotStat.size,
        integrity_check: integrityCheck,
      });
    }

    const snapshotSizeBytes = snapshots.reduce(
      (total, snapshot) => total + snapshot.size_bytes,
      0,
    );
    const includedFiles = [
      ...snapshots.map((snapshot) => snapshot.snapshot_file),
      "manifest.json",
    ];
    const manifest = {
      created_at: new Date().toISOString(),
      db_path: resolvedDbPath,
      corpus_layout: layout,
      snapshot_file: basename(dbPath),
      integrity_check: "ok",
      snapshot_size_bytes: snapshotSizeBytes,
      snapshots,
    };
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    if (force) await rm(outputPath, { force: true });
    await createTarGz(workDir, outputPath, includedFiles);
    const archiveStat = await stat(outputPath);
    reportProgressImmediate("backup.done", {
      archive_path: outputPath,
      size_bytes: archiveStat.size,
      database_count: snapshots.length,
    });

    return {
      data: {
        archive_path: outputPath,
        db_path: resolvedDbPath,
        corpus_layout: layout,
        size_bytes: archiveStat.size,
        snapshot_size_bytes: snapshotSizeBytes,
        integrity_check: "ok",
        snapshots,
        included_files: includedFiles,
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function inspectCorpus(dbPath: string): {
  layout: "split" | "pre-split";
  sources: SnapshotSource[];
} {
  const db = openDb({
    readonly: true,
    init: false,
    path: dbPath,
    allowPreSplit: true,
  });
  try {
    const layout = corpusLayout(db);
    const rawPath = archivePath("raw", dbPath);
    const toolsPath = archivePath("tools", dbPath);
    if (layout === "split") {
      const counts = db
        .prepare<[], { raw_count: number; tool_count: number }>(
          `SELECT COALESCE(SUM(raw_event_count), 0) AS raw_count,
                  COALESCE(SUM(tool_output_count), 0) AS tool_count
             FROM sessions`,
        )
        .get() ?? { raw_count: 0, tool_count: 0 };
      if (counts.raw_count > 0 && !existsSync(rawPath)) {
        throw Errors.dbError(
          `Raw-event archive is missing at ${rawPath}; refusing an incomplete backup.`,
        );
      }
      if (counts.tool_count > 0 && !existsSync(toolsPath)) {
        throw Errors.dbError(
          `Tool-output archive is missing at ${toolsPath}; refusing an incomplete backup.`,
        );
      }
    }

    const sources: SnapshotSource[] = [
      { sourcePath: dbPath, snapshotFile: basename(dbPath) },
    ];
    if (existsSync(rawPath)) {
      sources.push({ sourcePath: rawPath, snapshotFile: basename(rawPath) });
    }
    if (existsSync(toolsPath)) {
      sources.push({
        sourcePath: toolsPath,
        snapshotFile: basename(toolsPath),
      });
    }
    assertSafeSnapshotNames(sources);
    return { layout, sources };
  } finally {
    db.close();
  }
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);

  const tail: string[] = [];
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    tail.push(basename(ancestor));
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...tail.reverse());
}

function assertSafeSnapshotNames(sources: SnapshotSource[]): void {
  const reserved = new Set(["manifest.json"]);
  for (const source of sources) {
    const normalized = source.snapshotFile.toLowerCase();
    if (reserved.has(normalized)) {
      throw Errors.invalidInput(
        `Corpus database name is reserved by the backup format: ${source.snapshotFile}.`,
      );
    }
    reserved.add(normalized);
  }
}

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
    allowPreSplit: true,
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
    const child = spawn(
      "tar",
      ["-czf", archivePath, "-C", cwd, "--", ...files],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
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
