/**
 * Shared CLI filter helpers.
 *
 * Accept inputs in three shapes:
 *
 *   - Relative offset:   "7d", "2w", "12h", "30m" — from "now"
 *   - Bare date:         "2026-05-08" — interpreted as UTC midnight
 *   - ISO timestamp:     "2026-05-08T12:30:00Z" — passed to Date.parse
 *
 * Both return unix epoch seconds (or `null` if unparseable). `parseSince`
 * resolves bare dates to the start of the day; `parseUntil` resolves them
 * to the *start of the next day* so a YYYY-MM-DD upper bound is
 * inclusive of the named day's events.
 */

const RELATIVE_RE = /^(\d+)([smhdw])$/i;
const UNITS_TO_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 86400 * 7,
};

function parseRelativeSeconds(s: string): number | null {
  const m = RELATIVE_RE.exec(s.trim());
  if (!m) return null;
  const amount = Number.parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  const factor = UNITS_TO_SECONDS[unit];
  if (!Number.isFinite(amount) || factor === undefined) return null;
  return amount * factor;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function parseSince(s: string): number | null {
  const rel = parseRelativeSeconds(s);
  if (rel !== null) return nowSeconds() - rel;

  const isoLike = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
  const ms = Date.parse(isoLike);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

export function parseUntil(s: string): number | null {
  const rel = parseRelativeSeconds(s);
  if (rel !== null) return nowSeconds() - rel;

  // A bare YYYY-MM-DD upper bound should be *inclusive* of that day —
  // resolve to the start of the next UTC day so callers can use `< ?`.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(`${s}T00:00:00Z`);
    if (!Number.isFinite(ms)) return null;
    return Math.floor(ms / 1000) + 86400;
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}
