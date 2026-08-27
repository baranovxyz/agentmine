import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";

/** The errno `code` of a Node error, without an `as` cast. */
export function fileErrorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Publish a complete lock payload without exposing a zero-length final file.
 *
 * The temporary file is written and flushed first. Creating the hard link is
 * then one atomic exclusive operation: either this payload becomes the final
 * lock or an existing lock remains untouched.
 */
export function tryCreateLockFile(path: string, payload: string): boolean {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, "wx", 0o600);
    writeSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temporaryPath, path);
      return true;
    } catch (error) {
      if (fileErrorCode(error) === "EEXIST") return false;
      throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary name is never authoritative and may already be gone.
    }
  }
}

/**
 * Remove a lock owned by the current process.
 *
 * Agentmine never automatically reclaims lock files, so no cooperating process
 * can replace this generation between the comparison and unlink. Manual stale
 * recovery must happen only after every possible owner has been stopped.
 */
export function removeOwnedLockFile(
  path: string,
  expectedPayload: string,
): "removed" | "missing" | "changed" {
  let actualPayload: string;
  try {
    actualPayload = readFileSync(path, "utf8");
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return "missing";
    throw error;
  }
  if (actualPayload !== expectedPayload) return "changed";
  try {
    unlinkSync(path);
    return "removed";
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}
