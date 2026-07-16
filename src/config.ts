import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { loadExtensions } from "./extensions.js";

const HOME = homedir();
const APP_NAME = "agentmine";
const APP_DATA_ROOT = resolveAppDataRoot({ home: HOME, appName: APP_NAME });
const SESSIONS_ROOT = join(APP_DATA_ROOT, "sessions");

export interface AppDataRootOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  appName?: string;
}

export interface GooseDataPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  pathExists?: (path: string) => boolean;
}

export interface ClineSessionPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export function resolveAppDataRoot(options: AppDataRootOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const appName = options.appName ?? APP_NAME;

  if (platform === "win32") {
    return win32.join(
      envPath(env.APPDATA, win32.isAbsolute) ??
        win32.join(home, "AppData", "Roaming"),
      appName,
    );
  }

  return posix.join(
    envPath(env.XDG_DATA_HOME, posix.isAbsolute) ??
      posix.join(home, ".local", "share"),
    appName,
  );
}

export function resolveGooseDbCandidates(
  options: GooseDataPathOptions = {},
): [string, ...string[]] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const pathApi = platform === "win32" ? win32 : posix;

  const configuredRoot = env.GOOSE_PATH_ROOT;
  if (configuredRoot !== undefined && configuredRoot.length > 0) {
    return [pathApi.join(configuredRoot, "data", "sessions", "sessions.db")];
  }

  if (platform === "win32") {
    const appData =
      envPath(env.APPDATA, win32.isAbsolute) ??
      win32.join(home, "AppData", "Roaming");
    return [
      win32.join(appData, "Block", "goose", "data", "sessions", "sessions.db"),
    ];
  }

  const dataRoot =
    envPath(env.XDG_DATA_HOME, posix.isAbsolute) ??
    posix.join(home, ".local", "share");
  const currentPath = posix.join(dataRoot, "goose", "sessions", "sessions.db");

  if (platform === "darwin") {
    return [
      currentPath,
      posix.join(
        home,
        "Library",
        "Application Support",
        "Block",
        "goose",
        "data",
        "sessions",
        "sessions.db",
      ),
    ];
  }

  return [currentPath];
}

export function resolveGooseDbPath(options: GooseDataPathOptions = {}): string {
  const candidates = resolveGooseDbCandidates(options);
  const pathExists = options.pathExists ?? existsSync;
  return candidates.find((candidate) => pathExists(candidate)) ?? candidates[0];
}

/** Resolve Cline's session store with the same override precedence as Cline. */
export function resolveClineSessionsPath(
  options: ClineSessionPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const pathApi = platform === "win32" ? win32 : posix;

  const sessionsDir = nonEmptyEnvValue(env.CLINE_SESSION_DATA_DIR);
  if (sessionsDir !== undefined) return sessionsDir;

  const dataDir = nonEmptyEnvValue(env.CLINE_DATA_DIR);
  if (dataDir !== undefined) return pathApi.join(dataDir, "sessions");

  const clineDir = nonEmptyEnvValue(env.CLINE_DIR);
  if (clineDir !== undefined) return pathApi.join(clineDir, "data", "sessions");

  return pathApi.join(home, ".cline", "data", "sessions");
}

function nonEmptyEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function envPath(
  value: string | undefined,
  isAbsolute: (path: string) => boolean,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && isAbsolute(trimmed) ? trimmed : undefined;
}

export const paths = {
  appDataRoot: APP_DATA_ROOT,
  sessionsRoot: SESSIONS_ROOT,
  /**
   * Raw session archives mirror their original source directories below the
   * app-data sessions root. Derived data lives beside those mirrors.
   */
  rawClaudeCode: join(SESSIONS_ROOT, "claude-code"),
  rawCursor: join(SESSIONS_ROOT, "cursor"),
  rawOpencode: join(SESSIONS_ROOT, "opencode"),
  rawCodex: join(SESSIONS_ROOT, "codex"),
  rawGemini: join(SESSIONS_ROOT, "gemini"),
  rawQwen: join(SESSIONS_ROOT, "qwen"),
  rawCline: join(SESSIONS_ROOT, "cline"),
  normalized: join(SESSIONS_ROOT, "normalized"),
  transcripts: join(SESSIONS_ROOT, "transcripts"),
  summaries: join(SESSIONS_ROOT, "summaries"),
  reports: join(SESSIONS_ROOT, "reports"),
  backups: join(SESSIONS_ROOT, "backups"),
  db: join(SESSIONS_ROOT, "sessions.db"),
  /** Source-of-truth mirror of ~/.claude/projects to rsync from */
  sourceClaudeProjects: join(HOME, ".claude", "projects"),
  /** Source-of-truth mirror of ~/.cursor/projects to rsync from */
  sourceCursorProjects: join(HOME, ".cursor", "projects"),
  /** Source-of-truth opencode storage */
  sourceOpencodeStorage: join(HOME, ".local", "share", "opencode", "storage"),
  /** Source-of-truth opencode SQLite DB (newer opencode versions) */
  sourceOpencodeDb: join(HOME, ".local", "share", "opencode", "opencode.db"),
  /** Source-of-truth Kilo Code SQLite DB (opencode-lineage store) */
  sourceKiloDb: join(HOME, ".local", "share", "kilo", "kilo.db"),
  /** Platform-aware Goose global SQLite session store (`sessions.db`, WAL) */
  sourceGooseDb: resolveGooseDbPath({ home: HOME }),
  /** Source-of-truth Codex CLI rollouts */
  sourceCodexSessions: join(HOME, ".codex", "sessions"),
  /** Source-of-truth Gemini CLI transcripts (`~/.gemini/tmp/<project>/chats/`) */
  sourceGeminiSessions: join(HOME, ".gemini", "tmp"),
  /** Source-of-truth Qwen Code transcripts (`~/.qwen/projects/<cwd-slug>/chats/`) */
  sourceQwenSessions: join(HOME, ".qwen", "projects"),
  /** Source-of-truth Cline per-session JSON store, including Cline's path overrides. */
  sourceClineSessions: resolveClineSessionsPath({ home: HOME }),
} as const;

export const envKeys = {
  dbPath: "AGENTMINE_DB",
  projectPathAllow: "AGENTMINE_PROJECT_PATH_ALLOW",
} as const;

export function getDbPath(): string {
  return process.env[envKeys.dbPath] ?? paths.db;
}

/**
 * Returns the LLM base URL override from the extension config, if set.
 * Callers use this to route LLM requests through a custom proxy.
 */
export async function getLlmBaseUrl(): Promise<string | undefined> {
  const ext = await loadExtensions();
  return ext.llmBaseUrl;
}
