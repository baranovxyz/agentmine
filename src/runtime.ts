declare const AGENTMINE_BUILD_TARGET: string | undefined;
declare const AGENTMINE_BUILD_BUN_VERSION: string | undefined;
declare const AGENTMINE_BUILD_SOURCE_COMMIT: string | null | undefined;

interface BunRuntime {
  version?: string;
}

export interface RuntimeInfo {
  runtime: "node" | "bun-standalone";
  runtime_version: string;
  target: string | null;
  bun_version: string | null;
  source_commit: string | null;
}

export interface SelfInvocationSnapshot {
  standalone: boolean;
  execPath: string;
  execArgv: string[];
  argv: string[];
}

function bunRuntime(): BunRuntime | undefined {
  return (globalThis as { Bun?: BunRuntime }).Bun;
}

export function isStandaloneExecutable(): boolean {
  return buildTarget() !== null;
}

export function getRuntimeInfo(): RuntimeInfo {
  const bun = bunRuntime();
  const standalone = isStandaloneExecutable();
  return {
    runtime: standalone ? "bun-standalone" : "node",
    runtime_version: standalone
      ? (bun?.version ?? buildBunVersion() ?? "unknown")
      : process.versions.node,
    target: standalone ? buildTarget() : null,
    bun_version: standalone
      ? (buildBunVersion() ?? bun?.version ?? null)
      : null,
    source_commit: buildSourceCommit(),
  };
}

export interface SelfInvocation {
  command: string;
  args: string[];
  /**
   * The file that identifies *Agentmine* in this invocation, as opposed to the
   * interpreter running it. Under Node the command is the runtime, which a
   * version manager may move for reasons that have nothing to do with this
   * program, so anything asking "is my installation still the installed one"
   * must ask about the entrypoint instead.
   */
  programPath: string;
  /** Whether `programPath` is itself the executable that gets run. */
  programIsExecutable: boolean;
}

export function resolveSelfInvocation(
  args: string[],
  snapshot: SelfInvocationSnapshot = {
    standalone: isStandaloneExecutable(),
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
  },
): SelfInvocation {
  if (snapshot.standalone) {
    return {
      command: snapshot.execPath,
      args: [...args],
      programPath: snapshot.execPath,
      programIsExecutable: true,
    };
  }
  const entrypoint = snapshot.argv[1];
  if (!entrypoint) {
    throw new Error("Agentmine entrypoint is unavailable for self-execution");
  }
  return {
    command: snapshot.execPath,
    args: [...snapshot.execArgv, entrypoint, ...args],
    programPath: entrypoint,
    programIsExecutable: false,
  };
}

function buildTarget(): string | null {
  return typeof AGENTMINE_BUILD_TARGET === "string"
    ? AGENTMINE_BUILD_TARGET
    : null;
}

function buildBunVersion(): string | null {
  return typeof AGENTMINE_BUILD_BUN_VERSION === "string"
    ? AGENTMINE_BUILD_BUN_VERSION
    : null;
}

function buildSourceCommit(): string | null {
  return typeof AGENTMINE_BUILD_SOURCE_COMMIT === "string"
    ? AGENTMINE_BUILD_SOURCE_COMMIT
    : null;
}
