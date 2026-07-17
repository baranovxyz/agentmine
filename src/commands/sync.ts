import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import { paths } from "../config.js";
import { Errors } from "../contract/errors.js";
import { reportProgressImmediate } from "../contract/progress.js";
import { runCommand } from "../contract/result.js";

interface SyncTarget {
  name: string;
  source: string;
  target: string;
  /** When true, missing source is silently skipped instead of erroring. */
  optional?: boolean;
}

const TARGETS: SyncTarget[] = [
  {
    name: "claude-code",
    source: paths.sourceClaudeProjects,
    target: paths.rawClaudeCode,
  },
  {
    name: "cursor",
    source: paths.sourceCursorProjects,
    target: paths.rawCursor,
    optional: true,
  },
  {
    name: "codex",
    source: paths.sourceCodexSessions,
    target: paths.rawCodex,
    optional: true,
  },
  {
    name: "gemini",
    source: paths.sourceGeminiSessions,
    target: paths.rawGemini,
    optional: true,
  },
  {
    name: "qwen",
    source: paths.sourceQwenSessions,
    target: paths.rawQwen,
    optional: true,
  },
  {
    name: "cline",
    source: paths.sourceClineSessions,
    target: paths.rawCline,
    optional: true,
  },
  {
    name: "copilot",
    source: paths.sourceCopilotSessions,
    target: paths.rawCopilot,
    optional: true,
  },
];

export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description:
      "Rsync raw agent-session archives (claude-code, cursor, codex, gemini, qwen, cline, copilot) into the app-data sessions root",
  },
  args: {
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Show what would be copied without writing",
    },
    source: {
      type: "string",
      description: `Filter to one source: ${TARGETS.map((t) => t.name).join("|")}`,
    },
    "claude-history": {
      type: "string",
      description:
        "Comma-separated Claude Code history tarballs to extract into the Claude Code sessions mirror",
    },
    "discover-claude-history": {
      type: "boolean",
      default: false,
      description:
        "Also extract ~/claude-history*.tar.gz into the Claude Code sessions mirror",
    },
  },
  async run({ args }) {
    await runCommand({
      command: "agentmine sync",
      handler: async () => {
        const filter = args.source ? String(args.source) : undefined;
        let targets = TARGETS;
        if (filter) {
          targets = TARGETS.filter((t) => t.name === filter);
          if (targets.length === 0) {
            throw Errors.invalidInput(
              `--source must be one of ${TARGETS.map((t) => t.name).join("|")} (got '${filter}')`,
            );
          }
        }

        const dryRun = Boolean(args["dry-run"]);
        const claudeHistoryArchives = unique([
          ...parseClaudeHistoryArg(args["claude-history"]),
          ...(args["discover-claude-history"]
            ? discoverClaudeHistoryArchives()
            : []),
        ]);
        const results: Array<{
          source: string;
          target: string;
          status: "synced" | "skipped" | "failed";
          exitCode?: number | null;
          files?: number;
        }> = [];

        for (const t of targets) {
          if (!existsSync(t.source)) {
            if (t.optional) {
              results.push({
                source: t.source,
                target: t.target,
                status: "skipped",
              });
              continue;
            }
            throw Errors.notFound(
              `Source ${t.source} not found. ${t.name} may not be installed for this user.`,
            );
          }
          mkdirSync(t.target, { recursive: true });
          reportProgressImmediate("sync.start", {
            name: t.name,
            source: t.source,
            target: t.target,
          });
          // Archive mode preserves special files by default. Agent
          // transcript stores only need regular files, directories, and links;
          // live stores may also contain sockets (for example Cursor's
          // worker.sock), which cannot be recreated in the mirror reliably.
          const rsyncArgs = [
            "-a",
            "--no-specials",
            `${t.source}/`,
            `${t.target}/`,
          ];
          if (dryRun) rsyncArgs.unshift("--dry-run");
          const result = await runRsync(rsyncArgs);
          reportProgressImmediate("sync.done", {
            name: t.name,
            exitCode: result.exitCode,
          });
          if (result.exitCode !== 0) {
            throw Errors.ioError(
              `rsync ${t.name} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
              t.source,
            );
          }
          results.push({
            source: t.source,
            target: t.target,
            status: "synced",
            exitCode: result.exitCode,
          });
        }

        for (const archive of claudeHistoryArchives) {
          if (!existsSync(archive)) {
            throw Errors.notFound(
              `Claude history archive not found: ${archive}`,
            );
          }
          mkdirSync(paths.rawClaudeCode, { recursive: true });
          reportProgressImmediate("sync.claude_history.start", {
            archive,
            target: paths.rawClaudeCode,
            dryRun,
          });
          const listResult = await runTar(["-tzf", archive]);
          if (listResult.exitCode !== 0) {
            throw Errors.ioError(
              `tar list failed for Claude history archive (exit ${listResult.exitCode}): ${listResult.stderr.slice(0, 500)}`,
              archive,
            );
          }
          const files = countClaudeProjectJsonl(listResult.stdout);
          if (!dryRun) {
            const extractResult = await runTar([
              "-xzf",
              archive,
              "-C",
              paths.rawClaudeCode,
              "--strip-components=2",
              ".claude/projects",
            ]);
            if (extractResult.exitCode !== 0) {
              throw Errors.ioError(
                `tar extract failed for Claude history archive (exit ${extractResult.exitCode}): ${extractResult.stderr.slice(0, 500)}`,
                archive,
              );
            }
          }
          reportProgressImmediate("sync.claude_history.done", {
            archive,
            files,
            dryRun,
          });
          results.push({
            source: archive,
            target: paths.rawClaudeCode,
            status: "synced",
            exitCode: 0,
            files,
          });
        }

        return {
          data: {
            dryRun,
            results,
          },
        };
      },
    });
  },
});

function parseClaudeHistoryArg(value: unknown): string[] {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function discoverClaudeHistoryArchives(): string[] {
  const home = homedir();
  try {
    return readdirSync(home)
      .filter(
        (name) => name.startsWith("claude-history") && name.endsWith(".tar.gz"),
      )
      .sort()
      .map((name) => join(home, name));
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function countClaudeProjectJsonl(tarList: string): number {
  return tarList
    .split("\n")
    .filter(
      (line) => line.startsWith(".claude/projects/") && line.endsWith(".jsonl"),
    ).length;
}

function runRsync(
  rsyncArgs: string[],
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn("rsync", rsyncArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", (code) => resolve({ exitCode: code, stderr, stdout }));
  });
}

function runTar(
  tarArgs: string[],
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn("tar", tarArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", (code) => resolve({ exitCode: code, stderr, stdout }));
  });
}
