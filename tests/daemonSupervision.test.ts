import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BANDS } from "../src/daemon/config.js";
import { buildServiceDefinition } from "../src/daemon/service.js";
import {
  assessProgramDurability,
  captureProgramIdentity,
  checkCorpusSupersession,
  checkProgramSupersession,
} from "../src/daemon/supervision.js";
import { openDb, upsertMeta } from "../src/db/client.js";
import {
  DAEMON_HEARTBEAT_META_KEY,
  readSupervision,
  readSupervisionSnapshot,
  recordStandDown,
  recordSupervision,
  SUPERVISION_STALE_AFTER_MS,
  supervisionWarnings,
} from "../src/db/supervision.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-supervision-test-"));
  tempDirs.push(dir);
  return dir;
}

/** A program somewhere ordinary: not a checkout, not the temp directory. */
function makeProgram(dir: string, name = "agentmine"): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

/**
 * Assess against a temporary root that is not the real one.
 *
 * Fixtures have to live in a temporary directory, and judging them against the
 * real one would make every case report `temporary` and prove nothing.
 */
function assess(programPath: string, requireExecutable = true) {
  return assessProgramDurability(programPath, requireExecutable, {
    temporaryRoot: join(tmpdir(), "agentmine-not-the-real-temp-root"),
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("program durability", () => {
  it("accepts a program in an ordinary location", async () => {
    const assessment = await assess(makeProgram(makeTempDir()));
    expect(assessment.verdict).toBe("durable");
  });

  it("refuses a program inside a source-control working tree", async () => {
    // The failure that motivated this: a definition generated from a build
    // directory in a checkout, which a later clean removed.
    const tree = makeTempDir();
    mkdirSync(join(tree, ".git"));
    mkdirSync(join(tree, "dist"));
    const assessment = await assess(makeProgram(join(tree, "dist"), "cli.js"));

    expect(assessment.verdict).toBe("working-tree");
    expect(assessment.detail).toContain(tree);
  });

  it("refuses a program reached by a link into a working tree", async () => {
    // The link itself sits somewhere perfectly ordinary; only its destination
    // reveals that it points into a checkout.
    const tree = makeTempDir();
    mkdirSync(join(tree, ".git"));
    const real = makeProgram(tree, "cli.js");
    const linkDir = makeTempDir();
    const link = join(linkDir, "agentmine");
    symlinkSync(real, link);

    const assessment = await assess(link);

    expect(assessment.verdict).toBe("linked-dependency");
    expect(assessment.resolved_path).toBe(real);
  });

  it("refuses a program under the temporary directory", async () => {
    const dir = makeTempDir();
    const assessment = await assessProgramDurability(makeProgram(dir), true, {
      temporaryRoot: dir,
    });
    expect(assessment.verdict).toBe("temporary");
  });

  it("refuses a program that is not there", async () => {
    const assessment = await assess(join(makeTempDir(), "missing"));
    expect(assessment.verdict).toBe("absent");
  });

  it("refuses an executable that cannot be run", async () => {
    const path = join(makeTempDir(), "agentmine");
    writeFileSync(path, "");
    chmodSync(path, 0o644);

    expect((await assess(path)).verdict).toBe("unreadable");
    // The Node distribution names a script the runtime reads rather than
    // executes, so the same file is fine when it is not the executable.
    expect((await assess(path, false)).verdict).toBe("durable");
  });
});

describe("supersession while running", () => {
  it("stands down when the program is replaced where it stands", async () => {
    const path = makeProgram(makeTempDir());
    const identity = await captureProgramIdentity(path);
    expect(identity).toBeDefined();
    if (identity === undefined) return;

    writeFileSync(path, "#!/bin/sh\n# a newer version, of a different size\n");
    const check = await checkProgramSupersession(identity);

    expect(check).toMatchObject({
      superseded: true,
      reason: "program-replaced",
    });
  });

  it("stands down when a link is repointed at a new version", async () => {
    // How package managers that install through a stable path upgrade: what
    // the link points at changes, while the link itself does not.
    const dir = makeTempDir();
    const first = makeProgram(dir, "agentmine-1");
    const second = makeProgram(dir, "agentmine-2");
    const link = join(dir, "agentmine");
    symlinkSync(first, link);

    const identity = await captureProgramIdentity(link);
    expect(identity).toBeDefined();
    if (identity === undefined) return;

    unlinkSync(link);
    symlinkSync(second, link);

    expect(await checkProgramSupersession(identity)).toMatchObject({
      superseded: true,
      reason: "program-replaced",
    });
  });

  it("stands down loudly when the program is gone", async () => {
    const path = makeProgram(makeTempDir());
    const identity = await captureProgramIdentity(path);
    expect(identity).toBeDefined();
    if (identity === undefined) return;

    unlinkSync(path);

    expect(await checkProgramSupersession(identity)).toMatchObject({
      superseded: true,
      reason: "program-missing",
    });
  });

  it("keeps running while nothing has changed", async () => {
    const identity = await captureProgramIdentity(makeProgram(makeTempDir()));
    expect(identity).toBeDefined();
    if (identity === undefined) return;

    expect(await checkProgramSupersession(identity)).toEqual({
      superseded: false,
    });
  });

  it("stands down when a separate installation migrates the corpus", () => {
    // The case the program check structurally cannot see: this daemon's own
    // files are untouched, and only the corpus reveals the upgrade.
    expect(checkCorpusSupersession(17, 16)).toMatchObject({
      superseded: true,
      reason: "corpus-migrated",
    });
    expect(checkCorpusSupersession(16, 16)).toEqual({ superseded: false });
    expect(checkCorpusSupersession(undefined, 16)).toEqual({
      superseded: false,
    });
  });
});

describe("the declaration a read command is held to", () => {
  function corpus(): ReturnType<typeof openDb> {
    return openDb({ path: join(makeTempDir(), "sessions.db") });
  }

  function declare(db: ReturnType<typeof openDb>, definitionPath: string) {
    recordSupervision(db, {
      kind: "systemd",
      definition_path: definitionPath,
      program_path: "/usr/local/bin/agentmine",
      installed_at: "2026-08-18T09:00:00.000Z",
    });
  }

  it("says nothing when nobody declared supervision", () => {
    const db = corpus();
    const snapshot = readSupervisionSnapshot(db, new Date());

    expect(snapshot.supervision_stalled).toBe(false);
    expect(supervisionWarnings(snapshot)).toEqual([]);
    db.close();
  });

  it("reports a declared daemon that has stopped cycling", () => {
    const db = corpus();
    const definition = join(makeTempDir(), "agentmine-daemon.service");
    writeFileSync(definition, "");
    declare(db, definition);
    upsertMeta(db, DAEMON_HEARTBEAT_META_KEY, "2026-08-18T09:00:00.000Z");

    const snapshot = readSupervisionSnapshot(
      db,
      new Date("2026-08-18T12:00:00.000Z"),
    );

    expect(snapshot.supervision_stalled).toBe(true);
    expect(supervisionWarnings(snapshot)[0]?.name).toBe("DAEMON_NOT_RUNNING");
    db.close();
  });

  it("stays quiet while a declared daemon is still cycling", () => {
    // Asserted in both directions on purpose: a report that is always emitted
    // is indistinguishable from a correct one on the failing case alone.
    const db = corpus();
    const definition = join(makeTempDir(), "agentmine-daemon.service");
    writeFileSync(definition, "");
    declare(db, definition);
    upsertMeta(db, DAEMON_HEARTBEAT_META_KEY, "2026-08-18T11:59:00.000Z");

    const snapshot = readSupervisionSnapshot(
      db,
      new Date("2026-08-18T12:00:00.000Z"),
    );

    expect(snapshot.supervision_stalled).toBe(false);
    expect(supervisionWarnings(snapshot)).toEqual([]);
    db.close();
  });

  it("explains a stand-down when one was recorded", () => {
    const db = corpus();
    const definition = join(makeTempDir(), "agentmine-daemon.service");
    writeFileSync(definition, "");
    declare(db, definition);
    upsertMeta(db, DAEMON_HEARTBEAT_META_KEY, "2026-08-18T09:00:00.000Z");
    recordStandDown(db, {
      reason: "program-replaced",
      detail:
        "/usr/local/bin/agentmine was replaced while the daemon was running",
      at: "2026-08-18T09:01:00.000Z",
    });

    const [warning] = supervisionWarnings(
      readSupervisionSnapshot(db, new Date("2026-08-18T12:00:00.000Z")),
    );

    expect(warning?.message).toContain("was replaced");
    db.close();
  });

  it("lets the declaration expire with the definition it describes", () => {
    const db = corpus();
    const definition = join(makeTempDir(), "agentmine-daemon.service");
    declare(db, definition);
    upsertMeta(db, DAEMON_HEARTBEAT_META_KEY, "2026-08-18T09:00:00.000Z");

    // Recorded, but the file it names is not there: the operator removed it,
    // which is how a declaration is withdrawn.
    expect(readSupervision(db)).toBeDefined();
    const snapshot = readSupervisionSnapshot(
      db,
      new Date("2026-08-18T12:00:00.000Z"),
    );

    expect(snapshot.definition_present).toBe(false);
    expect(supervisionWarnings(snapshot)).toEqual([]);
    db.close();
  });
});

describe("the removal instructions", () => {
  const invocation = {
    command: "/usr/local/bin/agentmine",
    args: ["daemon"],
  };

  it("deletes the definition, not just the service", () => {
    // The definition is what records that this corpus is meant to be fed, so
    // leaving it behind would keep reads reporting a daemon the operator
    // deliberately stopped.
    const unit = buildServiceDefinition("systemd", invocation, "/home/dev");
    expect(unit.disableCommands.join(" ")).toContain(`rm ${unit.path}`);

    const agent = buildServiceDefinition("launchd", invocation, "/Users/dev");
    expect(agent.disableCommands.join(" ")).toContain(`rm ${agent.path}`);
  });
});

describe("the reporting window", () => {
  it("waits for the slowest stated detection bound", () => {
    // The two are only correct together: reporting sooner than the slowest
    // band's interval would call a healthy daemon broken.
    const slowest = Math.max(...DEFAULT_BANDS.map((band) => band.intervalMs));
    expect(SUPERVISION_STALE_AFTER_MS).toBe(slowest);
  });
});
