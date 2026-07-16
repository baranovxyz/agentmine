import { v7 as uuidv7 } from "uuid";
import { CliError, type CliErrorShape, wrapUnknown } from "./errors.js";
import {
  ExitCode,
  type ExitCodeValue,
  exitCodeForCategory,
} from "./exitCodes.js";

export interface CliWarning {
  name: string;
  message: string;
  path?: string;
}

export interface Pagination {
  cursor: string | null;
  has_more: boolean;
  total?: number;
  page_size: number;
}

export type CliStatus = "success" | "partial" | "error";

export interface CliResult<T> {
  version: number;
  status: CliStatus;
  command: string;
  data: T | null;
  errors?: CliErrorShape[];
  warnings?: CliWarning[];
  pagination?: Pagination;
  traceId: string;
  _meta?: Record<string, unknown>;
}

export const CLI_OUTPUT_VERSION = 1;

export interface RunOptions<T> {
  command: string;
  handler: () => Promise<CommandOutcome<T>> | CommandOutcome<T>;
}

export interface CommandOutcome<T> {
  data: T;
  warnings?: CliWarning[];
  pagination?: Pagination;
  meta?: Record<string, unknown>;
  /** Set to "partial" if some work succeeded but some failed (errors[] populated). */
  status?: "success" | "partial";
  errors?: CliErrorShape[];
}

/**
 * Run a command handler and emit a canonical CliResult envelope to stdout.
 * Every CLI command goes through this; it guarantees contract conformance.
 */
export async function runCommand<T>({
  command,
  handler,
}: RunOptions<T>): Promise<never> {
  const traceId = uuidv7();
  const startedAt = Date.now();

  try {
    const outcome = await handler();
    const status: CliStatus = outcome.status ?? "success";
    const envelope: CliResult<T> = {
      version: CLI_OUTPUT_VERSION,
      status,
      command,
      data: outcome.data,
      traceId,
      _meta: { duration_ms: Date.now() - startedAt, ...(outcome.meta ?? {}) },
    };
    if (outcome.errors && outcome.errors.length > 0)
      envelope.errors = outcome.errors;
    if (outcome.warnings && outcome.warnings.length > 0)
      envelope.warnings = outcome.warnings;
    if (outcome.pagination) envelope.pagination = outcome.pagination;

    await writeStdoutLine(JSON.stringify(envelope));
    const exit: ExitCodeValue =
      status === "partial" ? ExitCode.PARTIAL : ExitCode.SUCCESS;
    process.exit(exit);
  } catch (err) {
    const cliErr: CliError = err instanceof CliError ? err : wrapUnknown(err);
    const envelope: CliResult<null> = {
      version: CLI_OUTPUT_VERSION,
      status: "error",
      command,
      data: null,
      errors: [cliErr.toJSON()],
      traceId,
      _meta: { duration_ms: Date.now() - startedAt },
    };
    await writeStdoutLine(JSON.stringify(envelope));
    process.exit(exitCodeForCategory(cliErr.category));
  }
}

function writeStdoutLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
