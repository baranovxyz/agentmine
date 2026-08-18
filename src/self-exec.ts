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
import { resolveSelfInvocation } from "./runtime.js";

export interface ChildResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function runSelf(args: string[]): Promise<ChildResult> {
  return new Promise((resolve) => {
    const invocation = resolveSelfInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}
