export type SkillOrigin = "project" | "user" | "plugin" | "unknown";

export interface ParsedSkillListingRow {
  skillName: string;
  description: string;
  origin: SkillOrigin;
}

const ORIGIN_HEADERS: Record<string, SkillOrigin> = {
  project: "project",
  user: "user",
  plugin: "plugin",
};

/**
 * Parse Claude Code skill catalog text from SessionStart hooks or
 * `attachment.type = skill_listing` blocks.
 *
 * Lines look like `- slug: description`. Slugs may contain colons
 * (e.g. `superpowers:brainstorming`, `plugin-dev:create-plugin`).
 */
export function parseSkillListingContent(
  content: string,
): ParsedSkillListingRow[] {
  const out: ParsedSkillListingRow[] = [];
  let origin: SkillOrigin = "unknown";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const header = line.match(/^#{1,3}\s+(.+)$/);
    if (header) {
      const key = header[1]!.trim().toLowerCase();
      origin = ORIGIN_HEADERS[key] ?? "unknown";
      continue;
    }

    if (!line.startsWith("- ")) continue;
    const rest = line.slice(2);
    const sep = rest.indexOf(": ");
    if (sep <= 0) continue;

    const skillName = rest.slice(0, sep).trim();
    const description = rest.slice(sep + 2).trim();
    if (!skillName) continue;

    out.push({ skillName, description, origin });
  }

  return out;
}

/** Match loaded catalog names to invoked / hook slugs. */
export function skillNamesMatch(
  availableName: string,
  usedSlug: string,
): boolean {
  if (!availableName || !usedSlug) return false;
  if (availableName === usedSlug) return true;
  if (availableName.endsWith(`:${usedSlug}`)) return true;
  if (usedSlug.endsWith(`:${availableName}`)) return true;
  const availTail = availableName.includes(":")
    ? availableName.slice(availableName.lastIndexOf(":") + 1)
    : availableName;
  const usedTail = usedSlug.includes(":")
    ? usedSlug.slice(usedSlug.lastIndexOf(":") + 1)
    : usedSlug;
  return availTail === usedTail;
}

export function slugFromSkillDirectory(path: string): string | null {
  const withFile = path.match(/skills(?:-[a-z]+)?\/([^/]+)\/SKILL\.md/i);
  if (withFile?.[1]) return withFile[1];
  // Hook preambles often end at the skill directory, not SKILL.md.
  const dirOnly = path.match(/\/skills(?:-[a-z]+)?\/([^/\s]+)\/?$/i);
  return dirOnly?.[1] ?? null;
}
