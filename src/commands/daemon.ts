/**
 * `agentmine daemon` — keep the corpus current without being asked.
 *
 * Long-running and foreground: supervision belongs to whatever the operator
 * already trusts to restart things (a user service, a terminal, a process
 * manager), not to a hand-rolled fork-and-detach here.
 *
 * Progress is NDJSON on stdout, one object per event. A long-lived process has
 * no single result envelope to return, so it streams instead — but each line
 * still names what ran, for which source, how long it took, and what it
 * processed, so a cycle that did nothing is distinguishable from a cycle that
 * never ran.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineCommand } from "citty";
import { z } from "zod";
import { Errors } from "../contract/errors.js";
import { reportProgressImmediate } from "../contract/progress.js";
import { runCommand } from "../contract/result.js";
import {
  allSources,
  type DaemonSource,
  DEFAULT_CONFIG,
  daemonConfigSchema,
  scanRoot,
} from "../daemon/config.js";
import {
  type DaemonEvent,
  IngestDaemon,
  type StepOutcome,
} from "../daemon/daemon.js";
import {
  acquireDaemonLock,
  recordDaemonHeartbeat,
  recordDaemonStandDown,
  recordDaemonStart,
  releaseDaemonLock,
} from "../daemon/liveness.js";
import { nodeScanFs, SourceIndex } from "../daemon/scan.js";
import {
  buildServiceDefinition,
  currentServiceKind,
} from "../daemon/service.js";
import {
  assessProgramDurability,
  captureProgramIdentity,
  checkCorpusSupersession,
  checkProgramSupersession,
  type SupersessionCheck,
} from "../daemon/supervision.js";
import {
  assertConfiguredCorpusReady,
  CURRENT_SCHEMA_VERSION,
  getMeta,
  openDb,
} from "../db/client.js";
import { recordSupervision } from "../db/supervision.js";
import { resolveSelfInvocation } from "../runtime.js";
import { runSelf } from "../self-exec.js";

/** How often the scheduler wakes to see whether anything is due. */
const TICK_MS = 500;

/**
 * The counters `normalize` actually emits.
 *
 * These names are snake_case and must match the command's real output. A
 * mismatch does not fail — it reports zero work forever, which reads exactly
 * like a correctly-running daemon with nothing to do, and is the single easiest
 * way to ship a daemon that silently does nothing.
 */
const normalizeEnvelopeSchema = z.object({
  status: z.string(),
  data: z
    .object({
      files_scanned: z.number().optional(),
      processed: z.number().optional(),
      skipped_unchanged: z.number().optional(),
      skipped_up_to_date: z.number().optional(),
      failed: z.number().optional(),
    })
    .partial()
    .nullable()
    .optional(),
});

export const daemonCommand = defineCommand({
  meta: {
    name: "daemon",
    description:
      "Continuously import local agent sessions so the corpus stays current",
  },
  args: {
    only: {
      type: "string",
      description:
        "Comma-separated source names to watch (default: all present)",
    },
    since: {
      type: "string",
      description: `--since window passed to each import (default: ${DEFAULT_CONFIG.sinceWindow})`,
    },
    "no-extract": {
      type: "boolean",
      default: false,
      description: "Import sessions but never derive fact tables",
    },
    "settle-ms": {
      type: "string",
      description: "Quiet period before importing a dirty source",
    },
    "ceiling-ms": {
      type: "string",
      description:
        "Maximum wait before importing a continuously-written source",
    },
    "dir-interval-ms": {
      type: "string",
      description: "How often directory modification times are checked",
    },
    "extract-settle-ms": {
      type: "string",
      description: "Quiet period before deriving fact tables",
    },
    "extract-ceiling-ms": {
      type: "string",
      description: "Maximum wait before deriving fact tables",
    },
    "exit-after-ms": {
      type: "string",
      description: "Stop after this long (for smoke tests)",
    },
    // Declared, not just read from `args`: an agent discovers this command
    // through `--help` and the `schema` manifest, so a working flag that
    // appears in neither is indistinguishable from one that does not exist.
    "print-service": {
      type: "boolean",
      default: false,
      description:
        "Print this platform's service definition instead of running",
    },
    "install-service": {
      type: "boolean",
      default: false,
      description:
        "Write the service definition, then print the commands to enable it",
    },
    "allow-ephemeral-path": {
      type: "boolean",
      default: false,
      description:
        "Generate a service definition even when this build lives somewhere that may not survive",
    },
  },
  async run({ args }) {
    await runCommand({
      command: "agentmine daemon",
      handler: async () => {
        assertConfiguredCorpusReady();

        const printService = Boolean(args["print-service"]);
        const installService = Boolean(args["install-service"]);
        if (printService || installService) {
          return serviceDefinitionResult(args, installService);
        }

        const config = daemonConfigSchema.parse({
          ...DEFAULT_CONFIG,
          only: splitList(args.only),
          sinceWindow: args.since
            ? String(args.since)
            : DEFAULT_CONFIG.sinceWindow,
          noExtract: Boolean(args["no-extract"]),
          settleMs: intArg(args["settle-ms"], DEFAULT_CONFIG.settleMs),
          ceilingMs: intArg(args["ceiling-ms"], DEFAULT_CONFIG.ceilingMs),
          dirIntervalMs: intArg(
            args["dir-interval-ms"],
            DEFAULT_CONFIG.dirIntervalMs,
          ),
          extractSettleMs: intArg(
            args["extract-settle-ms"],
            DEFAULT_CONFIG.extractSettleMs,
          ),
          extractCeilingMs: intArg(
            args["extract-ceiling-ms"],
            DEFAULT_CONFIG.extractCeilingMs,
          ),
          heartbeatIntervalMs: DEFAULT_CONFIG.heartbeatIntervalMs,
          supersessionIntervalMs: DEFAULT_CONFIG.supersessionIntervalMs,
        });

        const only = new Set(config.only);
        const sources = allSources().filter(
          (s) =>
            (only.size === 0 || only.has(s.name)) && existsSync(scanRoot(s)),
        );
        if (sources.length === 0) {
          throw Errors.notFound(
            "No watchable session sources are present on this machine. Nothing to keep current.",
          );
        }

        const startedAt = new Date();
        const lock = await acquireDaemonLock(startedAt);
        if (!lock.acquired) {
          throw Errors.locked(
            `Another agentmine daemon is already running for this corpus (pid ${String(lock.heldByPid)}). ` +
              "Two daemons double the work without importing anything sooner.",
          );
        }

        const db = openDb();
        recordDaemonStart(db, startedAt);

        const totals = { imports: 0, extracts: 0, errors: 0 };
        const index = new SourceIndex(sources, nodeScanFs, config.bands);
        const daemon = new IngestDaemon(sources, index, config, {
          runImport: (source, since) => importSource(source, since),
          runExtract: () => runStage(["extract"]),
          heartbeat: async (at) => {
            recordDaemonHeartbeat(db, new Date(at));
          },
          onEvent: (event) => {
            if (event.kind === "imported") totals.imports += 1;
            if (event.kind === "extracted") totals.extracts += 1;
            if (event.kind === "error") totals.errors += 1;
            emit(event);
          },
        });

        await daemon.start(Date.now());

        // Captured after startup so a program that vanished during the initial
        // walk is reported by the running check rather than crashing the walk.
        const identity = await captureProgramIdentity(
          resolveSelfInvocation([]).programPath,
        );

        let standDown:
          | Extract<SupersessionCheck, { superseded: true }>
          | undefined;

        // Run until told to stop. The promise is what keeps the command alive,
        // so the result envelope is written once, on the way out.
        await new Promise<void>((resolve) => {
          let stopping = false;
          const stop = (): void => {
            if (stopping) return;
            stopping = true;
            clearInterval(timer);
            clearInterval(supervisionTimer);
            resolve();
          };
          const timer = setInterval(() => {
            void daemon.tick(Date.now()).catch((error: unknown) => {
              totals.errors += 1;
              emit({
                kind: "error",
                source: undefined,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          }, TICK_MS);

          const supervisionTimer = setInterval(() => {
            void (async () => {
              const check = await currentSupersession(db, identity);
              if (!check.superseded) return;
              standDown = check;
              emit({
                kind: "stood-down",
                reason: check.reason,
                message: check.detail,
              });
              stop();
            })().catch(() => {
              // A check that cannot run is not evidence of supersession, and
              // standing down on it would turn a transient read failure into a
              // restart loop.
            });
          }, config.supersessionIntervalMs);

          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
          const exitAfter = intArg(args["exit-after-ms"], 0);
          if (exitAfter > 0) setTimeout(stop, exitAfter);
        });

        if (standDown !== undefined) {
          recordDaemonStandDown(
            db,
            standDown.reason,
            standDown.detail,
            new Date(),
          );
        }
        await releaseDaemonLock();
        db.close();

        // Standing down is reported as a fault so the supervisor restarts the
        // daemon: the generated definitions restart on failure and deliberately
        // leave a clean exit alone, which is what makes an upgrade repair
        // itself without the operator.
        if (standDown !== undefined) {
          throw Errors.superseded(
            `Agentmine daemon stood down because ${standDown.detail}. ` +
              "A supervised daemon restarts into the current version; an unsupervised one should be started again.",
          );
        }

        return {
          data: {
            sources: sources.map((s) => s.name),
            started_at: startedAt.toISOString(),
            imports: totals.imports,
            extracts: totals.extracts,
            errors: totals.errors,
          },
        };
      },
    });
  },
});

/**
 * Generate — and optionally write — the service definition for this platform.
 *
 * The generated command carries whatever tuning flags were passed alongside
 * `--install-service`, so the supervised daemon runs the configuration the
 * operator actually asked for rather than the defaults.
 */
async function serviceDefinitionResult(
  args: Record<string, unknown>,
  install: boolean,
): Promise<{ data: Record<string, unknown> }> {
  const kind = currentServiceKind();
  if (kind === undefined) {
    throw Errors.invalidInput(
      `No supported service manager for platform ${process.platform}. ` +
        "Run `agentmine daemon` under whatever supervisor this machine uses.",
    );
  }

  const passthrough: string[] = ["daemon"];
  for (const flag of [
    "only",
    "since",
    "settle-ms",
    "ceiling-ms",
    "dir-interval-ms",
    "extract-settle-ms",
    "extract-ceiling-ms",
  ]) {
    const value = args[flag];
    if (typeof value === "string" && value.length > 0) {
      passthrough.push(`--${flag}`, value);
    }
  }
  if (args["no-extract"] === true) passthrough.push("--no-extract");

  const invocation = resolveSelfInvocation(passthrough);
  const durability = await assessProgramDurability(
    invocation.programPath,
    invocation.programIsExecutable,
  );
  if (
    durability.verdict !== "durable" &&
    args["allow-ephemeral-path"] !== true
  ) {
    throw Errors.invalidPath(
      durability.resolved_path,
      `${durability.detail}. A service definition names this location permanently, so a ` +
        "build that moves or is cleaned away leaves a service that fails silently while the " +
        "corpus stops advancing. Install Agentmine globally, or use a standalone executable on " +
        "PATH, then generate the definition from that. Pass --allow-ephemeral-path to supervise " +
        "this build anyway.",
    );
  }

  const definition = buildServiceDefinition(kind, invocation);

  if (install) {
    await mkdir(dirname(definition.path), { recursive: true });
    await writeFile(definition.path, definition.contents, "utf8");
    // Recorded only once the definition exists: the declaration describes a
    // file, and one that was never written would have reads reporting a daemon
    // nobody asked for.
    const db = openDb();
    try {
      recordSupervision(db, {
        kind: definition.kind,
        definition_path: definition.path,
        program_path: durability.resolved_path,
        installed_at: new Date().toISOString(),
      });
    } finally {
      db.close();
    }
  }

  return {
    data: {
      service: definition.kind,
      path: definition.path,
      installed: install,
      program: durability.resolved_path,
      program_durability: durability.verdict,
      enable: definition.enableCommands,
      disable: definition.disableCommands,
      // Returned either way so `--print-service` can be piped somewhere else.
      contents: definition.contents,
    },
  };
}

function emit(event: DaemonEvent): void {
  const { kind, ...rest } = event;
  reportProgressImmediate(`daemon.${kind}`, rest);
}

/**
 * Both arms of "am I still the installed Agentmine", cheapest first.
 *
 * The program check is a stat; the corpus check is a meta read on a connection
 * already open. Neither can substitute for the other: replacing this daemon's
 * own program is invisible in the corpus, and upgrading a *different*
 * installation is invisible on disk here.
 */
async function currentSupersession(
  db: ReturnType<typeof openDb>,
  identity: Awaited<ReturnType<typeof captureProgramIdentity>>,
): Promise<SupersessionCheck> {
  if (identity !== undefined) {
    const program = await checkProgramSupersession(identity);
    if (program.superseded) return program;
  }
  const recorded = getMeta(db, "schema_version");
  const version = recorded === undefined ? undefined : Number(recorded);
  return checkCorpusSupersession(
    version === undefined || Number.isNaN(version) ? undefined : version,
    CURRENT_SCHEMA_VERSION,
  );
}

/**
 * A mirrored source is copied before it is parsed; a database is read where it
 * lies. Getting this wrong is silent: importing the live opencode database
 * under its corpus name selects an empty legacy file mirror and reports a clean
 * run having imported none of it.
 */
async function importSource(
  source: DaemonSource,
  sinceWindow: string,
): Promise<StepOutcome> {
  if (source.kind === "mirror") {
    const synced = await runStage(["sync", "--source", source.name]);
    if (!synced.ok) return synced;
  }
  return runStage([
    "normalize",
    "--source",
    source.name,
    "--since",
    sinceWindow,
  ]);
}

async function runStage(args: string[]): Promise<StepOutcome> {
  const result = await runSelf(args);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `agentmine ${args.join(" ")} exited ${String(result.exitCode)}: ${result.stderr.trim().slice(-300)}`,
    };
  }
  const parsed = safeParseEnvelope(result.stdout);
  return {
    ok: true,
    filesScanned: parsed?.files_scanned,
    processed: parsed?.processed,
    skipped:
      (parsed?.skipped_unchanged ?? 0) + (parsed?.skipped_up_to_date ?? 0),
    failed: parsed?.failed,
  };
}

function safeParseEnvelope(
  stdout: string,
): z.infer<typeof normalizeEnvelopeSchema>["data"] {
  try {
    const parsed = normalizeEnvelopeSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.data : undefined;
  } catch {
    return undefined;
  }
}

function splitList(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function intArg(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
