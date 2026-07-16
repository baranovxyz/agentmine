import { envKeys } from "./config.js";

export interface ProjectPathAllowFilter {
  raw: string;
  patterns: string[];
}

export function parseProjectPathAllow(
  value: unknown,
): ProjectPathAllowFilter | null {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const patterns = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (patterns.length === 0) return null;
  return { raw, patterns };
}

export function getProjectPathAllowFromEnv(): ProjectPathAllowFilter | null {
  return parseProjectPathAllow(process.env[envKeys.projectPathAllow]);
}

export function projectPathMatchesAllow(
  projectPath: string | null | undefined,
  filter: ProjectPathAllowFilter | null,
): boolean {
  if (!filter) return true;
  if (!projectPath) return false;
  return filter.patterns.some((pattern) => projectPath.includes(pattern));
}
