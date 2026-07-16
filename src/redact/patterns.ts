/**
 * Token redaction patterns. Order matters: more-specific rules go first so
 * a Bearer-prefixed Slack token doesn't get partially matched twice.
 *
 * Each rule replaces matched text with `[REDACTED:<name>]`.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** Optional custom replacer; default is `[REDACTED:<name>]`. */
  replace?: (match: string) => string;
}

export const REDACTION_RULES: RedactionRule[] = [
  // PEM private keys — multi-line; must match early so its body isn't shredded by other rules.
  {
    name: "pem-private-key",
    pattern:
      /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
  },

  // Yandex OAuth tokens. `y1_` and `y1__` (the second underscore is captured by `[A-Za-z0-9_-]{20,}`).
  // `\b` prevents matching inside unrelated tokens.
  { name: "yandex-oauth", pattern: /\by1_[A-Za-z0-9_-]{20,}/g },

  // Anthropic / OpenAI-style keys (`sk-...`, `sk-ant-...`). Word boundary
  // prevents false positives like `poisk-<longtoken>` in file paths.
  {
    name: "anthropic-or-openai-key",
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  },

  // GitHub tokens. The four prefixes have a fixed 36-char tail.
  { name: "github-token", pattern: /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{36}\b/g },

  // AWS access key IDs (deterministic 16-char tail after AKIA).
  { name: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },

  // Slack bot/app/user/refresh/legacy tokens.
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },

  // Generic Bearer tokens. Conservative `[A-Za-z0-9_.-]{20,}` after the keyword.
  // Replacer keeps the "Bearer " prefix so the surrounding sentence still parses.
  {
    name: "bearer-token",
    pattern: /Bearer\s+[A-Za-z0-9_.-]{20,}/g,
    replace: () => "Bearer [REDACTED:bearer-token]",
  },

  // Env-value-like lines. Only the value portion is redacted, and only when the
  // variable name suggests secrets. Multiline-aware.
  {
    name: "env-value",
    pattern: /^(?:export\s+)?([A-Z_][A-Z_0-9]*)=([^\s'"]{20,})$/gm,
    replace: (match) => {
      const eq = match.indexOf("=");
      const head = match.slice(0, eq);
      const varName = head.replace(/^export\s+/, "");
      if (!/(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|COOKIE)/.test(varName)) {
        return match;
      }
      return `${head}=[REDACTED:env-value]`;
    },
  },
];
