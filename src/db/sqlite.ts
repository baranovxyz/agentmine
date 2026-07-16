/**
 * node:sqlite compatibility shim.
 *
 * Reproduces the slice of the `better-sqlite3` API that Agentmine uses
 * (`prepare<P, R>` / `pragma` / `transaction` / `execBatch` / `backup` / `close`
 * plus `Statement.get/all/run`) on top of Node's built-in `node:sqlite`
 * (`DatabaseSync`). This removes Agentmine's only native dependency, so installs
 * need no node-gyp compile, no prebuilt binary, and no pnpm build approval.
 * Requires Node's `node:sqlite` (Node >= 22.5; package `engines` pins >= 24).
 *
 * Typing contract: `node:sqlite` returns untyped rows
 * (`Record<string, SQLOutputValue>`). The type assertions confined to THIS file
 * (`asRow` / `asRows` and the `SQLInputValue` bind coercions) reproduce
 * better-sqlite3's COMPILE-TIME-ONLY typed-prepare contract — neither driver
 * validates rows at runtime. The trust boundary for untrusted external data is
 * the `agent-canonical` ingest parsers (zod `safeParse`), not read-back. Keeping
 * the assertions here means the ~57 call sites stay exactly as type-safe as they
 * were under better-sqlite3, with no scattered casts. See AGENTS.md.
 */
import { existsSync } from "node:fs";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
  backup as sqliteBackup,
} from "node:sqlite";

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface OpenOptions {
  /** Open read-only (no create, no writes). */
  readonly?: boolean;
  /** Throw if the file does not already exist (better-sqlite3 parity). */
  fileMustExist?: boolean;
}

export interface BackupProgress {
  totalPages: number;
  remainingPages: number;
}

export interface BackupOptions {
  progress?: (progress: BackupProgress) => unknown;
}

export interface PragmaOptions {
  /** Return only the first column of the first row (better-sqlite3 parity). */
  simple?: boolean;
}

// --- the sanctioned typing boundary for this file (see header) -----------
function asRow<R>(value: unknown): R | undefined {
  return value as R | undefined;
}
function asRows<R>(value: unknown): R[] {
  return value as R[];
}

/**
 * Normalize better-sqlite3 bind conventions to node:sqlite's stricter shape:
 *  - a lone array argument binds as the anonymous parameter LIST (better-sqlite3
 *    accepts `.all(arr)`; node:sqlite needs each value spread);
 *  - a plain object argument binds as NAMED parameters, which node:sqlite
 *    requires as the first argument;
 *  - everything else (scalars, BLOB views) is a positional value.
 */
function splitBindArgs(args: readonly unknown[]): {
  named?: Record<string, SQLInputValue>;
  anon: SQLInputValue[];
} {
  const namedParts: Record<string, SQLInputValue>[] = [];
  const anon: SQLInputValue[] = [];
  for (const arg of args) {
    if (isNamedParams(arg)) {
      namedParts.push(arg);
    } else if (Array.isArray(arg)) {
      anon.push(...(arg as SQLInputValue[]));
    } else {
      anon.push(arg as SQLInputValue);
    }
  }
  const named =
    namedParts.length > 0 ? Object.assign({}, ...namedParts) : undefined;
  return { named, anon };
}

function isNamedParams(value: unknown): value is Record<string, SQLInputValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  );
}
// -------------------------------------------------------------------------

export class Statement<
  BindParameters extends readonly unknown[] = unknown[],
  Result = unknown,
> {
  constructor(private readonly stmt: StatementSync) {}

  get(...params: BindParameters): Result | undefined {
    const { named, anon } = splitBindArgs(params);
    const row = named ? this.stmt.get(named, ...anon) : this.stmt.get(...anon);
    return asRow<Result>(row);
  }

  all(...params: BindParameters): Result[] {
    const { named, anon } = splitBindArgs(params);
    const rows = named ? this.stmt.all(named, ...anon) : this.stmt.all(...anon);
    return asRows<Result>(rows);
  }

  run(...params: BindParameters): RunResult {
    const { named, anon } = splitBindArgs(params);
    return named ? this.stmt.run(named, ...anon) : this.stmt.run(...anon);
  }
}

export class Database {
  private readonly handle: DatabaseSync;
  private txDepth = 0;

  constructor(path: string, options: OpenOptions = {}) {
    if (options.fileMustExist && !existsSync(path)) {
      throw new Error(`unable to open database file: ${path}`);
    }
    this.handle = new DatabaseSync(path, {
      readOnly: options.readonly ?? false,
    });
  }

  prepare<
    BindParameters extends readonly unknown[] = unknown[],
    Result = unknown,
  >(sql: string): Statement<BindParameters, Result> {
    return new Statement<BindParameters, Result>(this.handle.prepare(sql));
  }

  /**
   * better-sqlite3-style PRAGMA. Runs `PRAGMA <source>` via a prepared
   * statement (works for both getters and `key = value` setters). With
   * `{ simple: true }`, returns the first column of the first row.
   */
  pragma(source: string, options: PragmaOptions = {}): unknown {
    const rows = this.handle.prepare(`PRAGMA ${source}`).all();
    if (options.simple) {
      const first = rows[0];
      if (first === undefined) return undefined;
      return Object.values(first)[0];
    }
    return rows;
  }

  /**
   * better-sqlite3-style transaction wrapper. Returns a function that runs `fn`
   * inside BEGIN/COMMIT, rolling back on throw. Nested calls use SAVEPOINTs so a
   * transaction-wrapped function may itself call another.
   */
  transaction<Args extends unknown[], R>(
    fn: (...args: Args) => R,
  ): (...args: Args) => R {
    return (...args: Args): R => {
      const top = this.txDepth === 0;
      const savepoint = `agentmine_sp_${this.txDepth}`;
      this.control(top ? "BEGIN" : `SAVEPOINT ${savepoint}`);
      this.txDepth += 1;
      try {
        const result = fn(...args);
        this.txDepth -= 1;
        this.control(top ? "COMMIT" : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.txDepth -= 1;
        if (top) {
          this.control("ROLLBACK");
        } else {
          this.control(`ROLLBACK TO ${savepoint}`);
          this.control(`RELEASE ${savepoint}`);
        }
        throw error;
      }
    };
  }

  /** Apply a multi-statement SQL batch (schema application). */
  execBatch(sql: string): void {
    // Capture the batch method explicitly so it can be called with the
    // DatabaseSync receiver after crossing the compatibility type boundary.
    const handle = this.handle as unknown as { exec: (sql: string) => void };
    const batch = handle["exec"];
    batch.call(this.handle, sql);
  }

  async backup(
    destination: string,
    options: BackupOptions = {},
  ): Promise<void> {
    const report = options.progress;
    await sqliteBackup(this.handle, destination, {
      rate: 100,
      progress: report
        ? ({ totalPages, remainingPages }) => {
            report({ totalPages, remainingPages });
          }
        : undefined,
    });
  }

  close(): void {
    this.handle.close();
  }

  private control(sql: string): void {
    this.handle.prepare(sql).run();
  }
}
