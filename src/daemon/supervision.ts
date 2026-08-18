/**
 * Whether this daemon may be supervised, and whether it still should be.
 *
 * Two moments, one concern. At generation time the question is whether the
 * program about to be named in a service definition will still be there in a
 * month; a definition names an absolute location permanently, and a location
 * inside a build directory or a checkout is one `clean` away from a service
 * that fails silently while the corpus quietly stops advancing.
 *
 * While running, the question inverts: the program is still there, but is it
 * still the one the machine considers installed? A running process keeps the
 * image it started with, and no packaging channel restarts a per-user service,
 * so an upgrade otherwise leaves the interactive command on one version and the
 * process feeding its corpus on another, indefinitely and invisibly.
 */
import { access, constants, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, sep } from "node:path";
import { z } from "zod";
import type { StandDownReason } from "../db/supervision.js";

export const durabilityVerdictSchema = z.enum([
  "durable",
  "absent",
  "unreadable",
  "working-tree",
  "linked-dependency",
  "temporary",
]);
export type DurabilityVerdict = z.infer<typeof durabilityVerdictSchema>;

export interface DurabilityAssessment {
  verdict: DurabilityVerdict;
  /** The location actually assessed, after following any links. */
  resolved_path: string;
  /** Why, in the operator's terms. Empty for a durable program. */
  detail: string;
}

/**
 * Classify the program a service definition would name.
 *
 * Links are followed first and every judgement is made about the destination,
 * because that is what will be run. It is also what makes a linked development
 * build detectable at all: the link itself lives in a perfectly ordinary
 * location, and only its target reveals that it points into a checkout.
 */
export async function assessProgramDurability(
  programPath: string,
  requireExecutable: boolean,
  options: { temporaryRoot?: string } = {},
): Promise<DurabilityAssessment> {
  let resolved: string;
  try {
    resolved = await realpath(programPath);
  } catch {
    return {
      verdict: "absent",
      resolved_path: programPath,
      detail: `${programPath} does not exist`,
    };
  }

  try {
    await access(resolved, requireExecutable ? constants.X_OK : constants.R_OK);
  } catch {
    return {
      verdict: "unreadable",
      resolved_path: resolved,
      detail: requireExecutable
        ? `${resolved} is not executable`
        : `${resolved} cannot be read`,
    };
  }

  const temp = await resolveOrSelf(options.temporaryRoot ?? tmpdir());
  if (isInside(resolved, temp)) {
    return {
      verdict: "temporary",
      resolved_path: resolved,
      detail: `${resolved} is under the temporary directory ${temp}, which the system may delete at any time`,
    };
  }

  const workingTree = await findWorkingTree(resolved);
  if (workingTree !== undefined) {
    const linked = resolved !== programPath;
    return {
      verdict: linked ? "linked-dependency" : "working-tree",
      resolved_path: resolved,
      detail: linked
        ? `${programPath} links to ${resolved}, inside the source-control working tree at ${workingTree}`
        : `${resolved} is inside the source-control working tree at ${workingTree}`,
    };
  }

  return { verdict: "durable", resolved_path: resolved, detail: "" };
}

/** What a program looked like when the daemon started running it. */
export interface ProgramIdentity {
  /** As invoked, which is what gets re-resolved on every check. */
  path: string;
  resolved_path: string;
  inode: number;
  size: number;
  mtime_ms: number;
}

export async function captureProgramIdentity(
  programPath: string,
): Promise<ProgramIdentity | undefined> {
  try {
    const resolved = await realpath(programPath);
    const stats = await stat(resolved);
    return {
      path: programPath,
      resolved_path: resolved,
      inode: Number(stats.ino),
      size: stats.size,
      mtime_ms: stats.mtimeMs,
    };
  } catch {
    return undefined;
  }
}

export type SupersessionCheck =
  | { superseded: false }
  | { superseded: true; reason: StandDownReason; detail: string };

const NOT_SUPERSEDED: SupersessionCheck = { superseded: false };

/**
 * Has the program been replaced or removed since startup?
 *
 * Re-resolving from the original path is deliberate: package managers that
 * install through a stable link — replacing where it points rather than what it
 * contains — change nothing about the destination this daemon already resolved,
 * and comparing the destination alone would miss the upgrade entirely.
 */
export async function checkProgramSupersession(
  identity: ProgramIdentity,
): Promise<SupersessionCheck> {
  const current = await captureProgramIdentity(identity.path);
  if (current === undefined) {
    return {
      superseded: true,
      reason: "program-missing",
      detail: `${identity.path} is gone; the daemon cannot be restarted from it`,
    };
  }
  const changed =
    current.resolved_path !== identity.resolved_path ||
    current.inode !== identity.inode ||
    current.size !== identity.size ||
    current.mtime_ms !== identity.mtime_ms;
  return changed
    ? {
        superseded: true,
        reason: "program-replaced",
        detail: `${identity.path} was replaced while the daemon was running`,
      }
    : NOT_SUPERSEDED;
}

/**
 * Has a different installation upgraded the corpus out from under us?
 *
 * The case the program check structurally cannot see: two installations on one
 * machine, where the other one was upgraded and migrated the corpus while this
 * daemon's own files were never touched. It is also the longest-lived version
 * of the problem, because nothing about this process will ever change on its
 * own.
 */
export function checkCorpusSupersession(
  corpusSchemaVersion: number | undefined,
  supportedSchemaVersion: number,
): SupersessionCheck {
  if (corpusSchemaVersion === undefined) return NOT_SUPERSEDED;
  return corpusSchemaVersion > supportedSchemaVersion
    ? {
        superseded: true,
        reason: "corpus-migrated",
        detail: `the corpus is at schema ${corpusSchemaVersion} and this daemon supports ${supportedSchemaVersion}, so a newer Agentmine is installed`,
      }
    : NOT_SUPERSEDED;
}

/** Walk up looking for the marker a checkout leaves in its root. */
async function findWorkingTree(from: string): Promise<string | undefined> {
  const root = parse(from).root;
  let dir = dirname(from);
  for (;;) {
    try {
      await access(join(dir, ".git"), constants.F_OK);
      return dir;
    } catch {
      // Not this level; keep walking.
    }
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isInside(candidate: string, directory: string): boolean {
  const base = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return candidate === directory || candidate.startsWith(base);
}

async function resolveOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
