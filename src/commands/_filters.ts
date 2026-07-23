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
const CALENDAR_DATE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/;
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

function hasValidCalendarDate(input: string): boolean {
  const match = CALENDAR_DATE_PREFIX_RE.exec(input);
  if (!match) return true;

  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]!
  );
}

export function parseSince(s: string): number | null {
  const rel = parseRelativeSeconds(s);
  if (rel !== null) return nowSeconds() - rel;

  const input = s.trim();
  if (!hasValidCalendarDate(input)) return null;
  const isoLike = /^\d{4}-\d{2}-\d{2}$/.test(input)
    ? `${input}T00:00:00Z`
    : input;
  const ms = Date.parse(isoLike);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

export function parseUntil(s: string): number | null {
  const rel = parseRelativeSeconds(s);
  if (rel !== null) return nowSeconds() - rel;

  const input = s.trim();
  if (!hasValidCalendarDate(input)) return null;
  // A bare YYYY-MM-DD upper bound should be *inclusive* of that day —
  // resolve to the start of the next UTC day so callers can use `< ?`.
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const ms = Date.parse(`${input}T00:00:00Z`);
    if (!Number.isFinite(ms)) return null;
    return Math.floor(ms / 1000) + 86400;
  }
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}
