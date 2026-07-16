export type ErrorCategory = "user" | "system" | "transient";

export interface CliErrorShape {
  code: number;
  name: string;
  message: string;
  category: ErrorCategory;
  retryable: boolean;
  path?: string;
  retryAfterSeconds?: number;
  details?: Array<{ path: string; code: string; message: string }>;
}

export class CliError extends Error {
  readonly code: number;
  readonly cliName: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly path?: string;
  readonly retryAfterSeconds?: number;
  readonly details?: Array<{ path: string; code: string; message: string }>;

  constructor(init: CliErrorShape) {
    super(init.message);
    this.code = init.code;
    this.cliName = init.name;
    this.category = init.category;
    this.retryable = init.retryable;
    this.path = init.path;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.details = init.details;
  }

  toJSON(): CliErrorShape {
    return {
      code: this.code,
      name: this.cliName,
      message: this.message,
      category: this.category,
      retryable: this.retryable,
      ...(this.path !== undefined ? { path: this.path } : {}),
      ...(this.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: this.retryAfterSeconds }
        : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

// Factory helpers for common errors. Code ranges: 1xxx=user, 2xxx=system, 3xxx=transient.
export const Errors = {
  missingEnv(name: string, hint?: string): CliError {
    return new CliError({
      code: 1001,
      name: "MISSING_ENV",
      message: `Required environment variable ${name} is not set`,
      category: "user",
      retryable: false,
      ...(hint
        ? { details: [{ path: name, code: "hint", message: hint }] }
        : {}),
    });
  },
  invalidPath(path: string, reason: string): CliError {
    return new CliError({
      code: 1002,
      name: "INVALID_PATH",
      message: `Invalid path: ${path} (${reason})`,
      category: "user",
      retryable: false,
      path,
    });
  },
  invalidInput(message: string, path?: string): CliError {
    return new CliError({
      code: 1003,
      name: "INVALID_INPUT",
      message,
      category: "user",
      retryable: false,
      ...(path ? { path } : {}),
    });
  },
  notFound(what: string): CliError {
    return new CliError({
      code: 1004,
      name: "NOT_FOUND",
      message: what,
      category: "user",
      retryable: false,
    });
  },
  ioError(message: string, path?: string): CliError {
    return new CliError({
      code: 2001,
      name: "IO_ERROR",
      message,
      category: "system",
      retryable: false,
      ...(path ? { path } : {}),
    });
  },
  dbError(message: string): CliError {
    return new CliError({
      code: 2002,
      name: "DB_ERROR",
      message,
      category: "system",
      retryable: false,
    });
  },
  internal(message: string): CliError {
    return new CliError({
      code: 2999,
      name: "INTERNAL",
      message,
      category: "system",
      retryable: false,
    });
  },
  locked(message: string, retryAfterSeconds = 5): CliError {
    return new CliError({
      code: 3003,
      name: "LOCKED",
      message,
      category: "transient",
      retryable: true,
      retryAfterSeconds,
    });
  },
  rateLimit(retryAfterSeconds: number): CliError {
    return new CliError({
      code: 3001,
      name: "RATE_LIMIT",
      message: "Rate limited by upstream service",
      category: "transient",
      retryable: true,
      retryAfterSeconds,
    });
  },
  network(message: string): CliError {
    return new CliError({
      code: 3002,
      name: "NETWORK",
      message,
      category: "transient",
      retryable: true,
    });
  },
};

export function wrapUnknown(err: unknown, contextMessage?: string): CliError {
  if (err instanceof CliError) return err;
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Unknown error";
  const full = contextMessage ? `${contextMessage}: ${msg}` : msg;
  return Errors.internal(full);
}
