/**
 * Pure recovery of skill listings from one raw source event.
 *
 * Kept free of database access so it can run at normalize time, where the
 * parsed events are already in memory, instead of re-scanning archived payload
 * during extract.
 *
 * Sources (claude-code only):
 *   - attachment.type = skill_listing (primary since CC ~2.1)
 *   - user raw lines carrying a SessionStart system-reminder skill catalog
 */

import { parseSkillListingContent } from "./parseSkillListing.js";

export const SKILL_LISTING_MARKER =
  "The following skills are available for use with the Skill tool";

export interface RawSkillListing {
  skills: ReturnType<typeof parseSkillListingContent>;
  isInitial: boolean;
}

/**
 * @param eventType the raw event's type. Each branch below is only valid for
 *   its own event type — the same gating the previous SQL applied with
 *   `event_type = 'attachment'` / `event_type = 'user'`. Pass `undefined` to
 *   consider both branches.
 */
export function extractListingsFromRaw(
  rawJson: string,
  eventType?: string | null,
): RawSkillListing[] {
  const considerAttachment =
    eventType === undefined || eventType === null || eventType === "attachment";
  const considerUser =
    eventType === undefined || eventType === null || eventType === "user";
  if (!considerAttachment && !considerUser) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  const obj = asRecord(parsed);
  if (obj === null) return [];

  const out: RawSkillListing[] = [];

  if (considerAttachment) {
    const attachment = asRecord(obj.attachment);
    const attachmentContent = pickString(attachment, "content");
    if (
      pickString(attachment, "type") === "skill_listing" &&
      attachmentContent
    ) {
      out.push({
        skills: parseSkillListingContent(attachmentContent),
        isInitial: attachment?.isInitial === true,
      });
      return out;
    }
  }

  if (considerUser) {
    const text = extractUserText(obj);
    if (text.includes(SKILL_LISTING_MARKER)) {
      out.push({
        skills: parseSkillListingContent(text),
        isInitial: true,
      });
    }
  }
  return out;
}

function extractUserText(obj: Record<string, unknown>): string {
  const message = asRecord(obj.message);
  if (obj.type !== "user" && message?.role !== "user") return "";
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const partRecord = asRecord(part);
      const text = pickString(partRecord, "text");
      return pickString(partRecord, "type") === "text" && text ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function pickString(
  obj: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = obj?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
