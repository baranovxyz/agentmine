import type { RedactionRule } from "../adapters/extension-types.js";
import type { CanonicalSession } from "../adapters/types.js";
import { REDACTION_RULES } from "./patterns.js";

/**
 * Apply every redaction rule to a string.
 *
 * Returns the redacted text, the total number of substitutions made, and a
 * per-rule breakdown (useful for the dry-run audit report).
 */
export interface RedactResult {
  text: string;
  count: number;
  byRule: Record<string, number>;
}

export function redactText(
  input: string,
  extraRules: RedactionRule[] = [],
): RedactResult {
  let out = input;
  let total = 0;
  const byRule: Record<string, number> = {};

  const rules =
    extraRules.length > 0
      ? [...REDACTION_RULES, ...extraRules]
      : REDACTION_RULES;
  for (const rule of rules) {
    const replacer = rule.replace ?? (() => `[REDACTED:${rule.name}]`);
    let ruleCount = 0;
    out = out.replace(rule.pattern, (match: string) => {
      const replaced = replacer(match);
      if (replaced !== match) {
        ruleCount += 1;
      }
      return replaced;
    });
    if (ruleCount > 0) {
      byRule[rule.name] = ruleCount;
      total += ruleCount;
    }
  }

  return { text: out, count: total, byRule };
}

/**
 * Redact in place across every text-bearing field of a canonical session:
 * `messages[].text`, `messageParts[].text`, `toolCalls[].argsPreview`,
 * `toolCalls[].outputPreview`.
 *
 * Mutates the session and returns the total number of redactions applied.
 * The caller stores this in `sessions.redaction_count`.
 *
 * The raw archive is NEVER modified — only the canonical/in-memory shape.
 */
export function redactSession(
  session: CanonicalSession,
  extraRules: RedactionRule[] = [],
): number {
  let total = 0;

  for (const msg of session.messages) {
    if (msg.text) {
      const r = redactText(msg.text, extraRules);
      if (r.count > 0) {
        msg.text = r.text;
        total += r.count;
      }
    }
    for (const tc of msg.toolCalls) {
      if (tc.argsPreview) {
        const r = redactText(tc.argsPreview, extraRules);
        if (r.count > 0) {
          tc.argsPreview = r.text;
          total += r.count;
        }
      }
      if (tc.outputPreview) {
        const r = redactText(tc.outputPreview, extraRules);
        if (r.count > 0) {
          tc.outputPreview = r.text;
          total += r.count;
        }
      }
    }
  }

  for (const part of session.messageParts ?? []) {
    if (part.text) {
      const r = redactText(part.text, extraRules);
      if (r.count > 0) {
        part.text = r.text;
        total += r.count;
      }
    }
  }

  return total;
}

/**
 * Aggregate redaction counts across a corpus, for the dry-run audit report.
 * Builds a `{ totalRedactions, perRule, perSessionTopN }` summary without
 * mutating anything.
 */
export interface RedactReport {
  sessionsScanned: number;
  totalRedactions: number;
  perRule: Record<string, number>;
  topSessions: Array<{ sessionId: string; count: number }>;
}

export function previewRedactSession(
  session: CanonicalSession,
  extraRules: RedactionRule[] = [],
): {
  count: number;
  byRule: Record<string, number>;
} {
  let count = 0;
  const byRule: Record<string, number> = {};
  for (const msg of session.messages) {
    accumulate(redactText(msg.text, extraRules), byRule);
    for (const tc of msg.toolCalls) {
      if (tc.argsPreview)
        accumulate(redactText(tc.argsPreview, extraRules), byRule);
      if (tc.outputPreview)
        accumulate(redactText(tc.outputPreview, extraRules), byRule);
    }
  }
  for (const part of session.messageParts ?? []) {
    if (part.text) accumulate(redactText(part.text, extraRules), byRule);
  }
  count = Object.values(byRule).reduce((a, b) => a + b, 0);
  return { count, byRule };
}

function accumulate(r: RedactResult, into: Record<string, number>): void {
  for (const [k, v] of Object.entries(r.byRule)) {
    into[k] = (into[k] ?? 0) + v;
  }
}
