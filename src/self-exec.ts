/**
 * Running agentmine from inside agentmine.
 *
 * `ingest` and the daemon both compose the pipeline out of the same commands a
 * person would run by hand, as child processes. Going through the real command
 * boundary keeps one implementation of each stage — including its locking,
 * validation, and result envelope — rather than a second in-process path that
 * can drift from the one users exercise.
 *
 * `resolveSelfInvocation` handles both the node entrypoint and the standalone
 * executable, so neither caller needs to know which it is running as.
 */
import { spawn } from "node:child_process";
import { z } from "zod";
import type { ProgressEvent } from "./contract/progress.js";
import { fileErrorCode } from "./lock-file.js";
import { resolveSelfInvocation, type SelfInvocation } from "./runtime.js";

const TERMINATE_GRACE_MS = 2_000;
const TERMINATE_POLL_MS = 25;
export const CHILD_STDERR_TAIL_MAX_CHARS = 16_384;
const CHILD_PROGRESS_LINE_MAX_CHARS = 65_536;
const progressEventSchema = z
  .object({
    event: z.literal("progress"),
    phase: z.string(),
  })
  .passthrough();

export interface ChildResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  aborted?: boolean;
}

export interface RunSelfOptions {
  /** Environment entries added to or replacing the current process environment. */
  env?: NodeJS.ProcessEnv;
  /** Stop the child when its owner is shutting down. */
  signal?: AbortSignal;
  /** Exact invocation override for focused process-lifecycle tests. */
  invocation?: SelfInvocation;
  /** Observe complete structured child progress events while they are running. */
  onProgress?: (event: ProgressEvent) => void;
}

export function runSelf(
  args: string[],
  options: RunSelfOptions = {},
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const invocation = options.invocation ?? resolveSelfInvocation(args);
    const ownsProcessGroup = process.platform !== "win32";
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      shell: false,
      detached: ownsProcessGroup,
    });
    const processGroupId = ownsProcessGroup ? child.pid : undefined;
    let stdout = "";
    let stderr = "";
    let progressLine = "";
    let droppingOversizedLine = false;
    let aborted = false;
    let settled = false;
    let directChildClosed = false;
    let directExitCode: number | null = null;
    let terminateTimer: NodeJS.Timeout | undefined;
    let terminatePoll: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (terminateTimer !== undefined) clearTimeout(terminateTimer);
      if (terminatePoll !== undefined) clearInterval(terminatePoll);
      options.signal?.removeEventListener("abort", terminate);
      resolve({ exitCode, stdout, stderr, aborted });
    };
    const processGroupAlive = (): boolean => {
      if (processGroupId === undefined) return false;
      try {
        process.kill(-processGroupId, 0);
        return true;
      } catch (error) {
        return fileErrorCode(error) === "EPERM";
      }
    };
    const maybeFinish = (): void => {
      if (!directChildClosed) return;
      if (aborted && processGroupAlive()) return;
      finish(directExitCode);
    };
    const signalTree = (signal: NodeJS.Signals): void => {
      if (processGroupId !== undefined) {
        try {
          process.kill(-processGroupId, signal);
          return;
        } catch (error) {
          if (fileErrorCode(error) === "ESRCH") return;
        }
      }
      child.kill(signal);
    };
    const terminate = (): void => {
      if (settled || aborted) return;
      aborted = true;
      signalTree("SIGTERM");
      terminateTimer = setTimeout(() => {
        if (!settled) signalTree("SIGKILL");
      }, TERMINATE_GRACE_MS);
      terminateTimer.unref();
      if (processGroupId !== undefined) {
        terminatePoll = setInterval(maybeFinish, TERMINATE_POLL_MS);
      }
      maybeFinish();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      stderr = appendTail(stderr, text, CHILD_STDERR_TAIL_MAX_CHARS);
      if (options.onProgress !== undefined) {
        ({ progressLine, droppingOversizedLine } = observeProgressLines(
          text,
          progressLine,
          droppingOversizedLine,
          options.onProgress,
        ));
      }
    });
    child.on("error", (error) => {
      stderr = appendTail(
        stderr,
        `${stderr.length > 0 ? "\n" : ""}${error.message}`,
        CHILD_STDERR_TAIL_MAX_CHARS,
      );
      directChildClosed = true;
      directExitCode = null;
      maybeFinish();
    });
    child.on("close", (exitCode) => {
      directChildClosed = true;
      directExitCode = exitCode;
      maybeFinish();
    });
    if (options.signal?.aborted) terminate();
    else options.signal?.addEventListener("abort", terminate, { once: true });
  });
}

function appendTail(current: string, chunk: string, maxChars: number): string {
  const combined = current + chunk;
  return combined.length <= maxChars ? combined : combined.slice(-maxChars);
}

function observeProgressLines(
  chunk: string,
  initialLine: string,
  initiallyDropping: boolean,
  observe: (event: ProgressEvent) => void,
): { progressLine: string; droppingOversizedLine: boolean } {
  let progressLine = initialLine;
  let droppingOversizedLine = initiallyDropping;
  let offset = 0;
  for (;;) {
    const newline = chunk.indexOf("\n", offset);
    const fragment = chunk.slice(offset, newline === -1 ? undefined : newline);
    if (!droppingOversizedLine) {
      if (
        progressLine.length + fragment.length <=
        CHILD_PROGRESS_LINE_MAX_CHARS
      ) {
        progressLine += fragment;
      } else {
        progressLine = "";
        droppingOversizedLine = true;
      }
    }
    if (newline === -1) break;
    if (!droppingOversizedLine) {
      const event = parseProgressEvent(progressLine);
      if (event !== undefined) observe(event);
    }
    progressLine = "";
    droppingOversizedLine = false;
    offset = newline + 1;
  }
  return { progressLine, droppingOversizedLine };
}

function parseProgressEvent(line: string): ProgressEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    const parsed = progressEventSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch {
    // Non-JSON diagnostics remain available only in the bounded stderr tail.
  }
  return undefined;
}
