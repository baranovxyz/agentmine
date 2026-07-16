import { describe, expect, it } from "vitest";
import type { CanonicalSession } from "../src/adapters/types.js";
import {
  previewRedactSession,
  redactSession,
  redactText,
} from "../src/redact/index.js";

describe("redactText", () => {
  it("redacts Yandex y1_ tokens", () => {
    const r = redactText("token=y1_AgAAAABabcdef0123456789xyz_-"); // gitleaks:allow -- synthetic fixture
    expect(r.text).toBe("token=[REDACTED:yandex-oauth]");
    expect(r.count).toBe(1);
    expect(r.byRule["yandex-oauth"]).toBe(1);
  });

  it("redacts Yandex y1__ tokens (double underscore variant)", () => {
    const r = redactText("y1__AgAAAABabcdef0123456789xyz_-");
    expect(r.text).toBe("[REDACTED:yandex-oauth]");
    expect(r.count).toBe(1);
  });

  it("redacts Anthropic and OpenAI sk- keys", () => {
    const r = redactText(
      'k1="sk-ant-api03-AAAAAAAAAAAAAAAAAAAA" k2="sk-AAAAAAAAAAAAAAAAAAAA"',
    );
    expect(r.text).toContain("[REDACTED:anthropic-or-openai-key]");
    expect(r.byRule["anthropic-or-openai-key"]).toBe(2);
  });

  it("redacts Bearer tokens but keeps the Bearer keyword", () => {
    const r = redactText("Authorization: Bearer abcdef0123456789ghijklmn");
    expect(r.text).toBe("Authorization: Bearer [REDACTED:bearer-token]");
  });

  it("redacts AWS access key IDs", () => {
    const r = redactText("AKIAIOSFODNN7EXAMPLE here");
    expect(r.text).toBe("[REDACTED:aws-access-key-id] here");
  });

  it("redacts every GitHub token prefix", () => {
    const r = redactText(
      "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa gho_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ghs_cccccccccccccccccccccccccccccccccccc ghr_dddddddddddddddddddddddddddddddddddd",
    );
    expect(r.byRule["github-token"]).toBe(4);
  });

  it("redacts Slack xox tokens", () => {
    const r = redactText(
      "xoxb-1234567890-abcdefghijklmn xoxa-foo-bar-baz12345",
    );
    expect(r.byRule["slack-token"]).toBe(2);
  });

  it("redacts PEM private keys across lines", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAabcdef
fakekeycontent
-----END RSA PRIVATE KEY-----`;
    const r = redactText(`before\n${pem}\nafter`);
    expect(r.text).toContain("before");
    expect(r.text).toContain("after");
    expect(r.text).toContain("[REDACTED:pem-private-key]");
    expect(r.text).not.toContain("BEGIN RSA");
  });

  it("redacts secret-shaped env-value lines, leaves benign env-value lines alone", () => {
    const input = [
      "API_TOKEN=abcdef0123456789xyzabcd", // gitleaks:allow -- synthetic fixture
      "MY_SECRET=qqqqqqqqqqqqqqqqqqqqqqqqqq",
      "PORT=8080",
      "PUBLIC_URL=https://example.com/very-long-public-path-here-yes",
    ].join("\n");
    const r = redactText(input);
    expect(r.text).toContain("API_TOKEN=[REDACTED:env-value]");
    expect(r.text).toContain("MY_SECRET=[REDACTED:env-value]");
    expect(r.text).toContain("PORT=8080");
    expect(r.text).toContain(
      "PUBLIC_URL=https://example.com/very-long-public-path-here-yes",
    );
  });

  it("leaves clean text untouched and reports zero count", () => {
    const r = redactText("nothing to see here, just a normal message");
    expect(r.count).toBe(0);
    expect(r.text).toBe("nothing to see here, just a normal message");
    expect(Object.keys(r.byRule)).toHaveLength(0);
  });

  it("applies extra rules passed at call site", () => {
    const r = redactText("hello my_secret_abc123", [
      { name: "my-token", pattern: /my_secret_[a-z0-9]+/g },
    ]);
    expect(r.text).toBe("hello [REDACTED:my-token]");
    expect(r.count).toBe(1);
  });
});

describe("redactSession", () => {
  it("redacts message text, tool args, and tool output; returns total count", () => {
    const session: CanonicalSession = {
      id: "test-1",
      source: "claude-code",
      messages: [
        {
          turn: 1,
          role: "user",
          text: "my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAA",
          toolCalls: [],
        },
        {
          turn: 2,
          role: "assistant",
          text: "ok",
          toolCalls: [
            {
              name: "Shell",
              argsHash: "x",
              argsPreview: "export TOKEN=y1_AAAAAAAAAAAAAAAAAAAAAAAA",
              outputPreview: "Bearer abcdef0123456789ghijklmnopqrst",
            },
          ],
        },
      ],
      contentHash: "h",
    };

    const total = redactSession(session);
    // 1 anthropic key + 1 env-value + 1 yandex-oauth (the y1_ inside the env value
    // gets caught first, then the env-value rule wraps the rest) + 1 bearer = 4.
    expect(total).toBe(4);
    expect(session.messages[0]?.text).toContain(
      "[REDACTED:anthropic-or-openai-key]",
    );
    expect(session.messages[1]?.toolCalls[0]?.argsPreview).toContain(
      "[REDACTED:",
    );
    expect(session.messages[1]?.toolCalls[0]?.outputPreview).toContain(
      "[REDACTED:bearer-token]",
    );
  });

  it("passes extra rules through to message text", () => {
    const session: CanonicalSession = {
      id: "test-extra",
      source: "claude-code",
      messages: [
        {
          turn: 1,
          role: "user",
          text: "token is custom_abc123xyz",
          toolCalls: [],
        },
      ],
      contentHash: "h",
    };
    const count = redactSession(session, [
      { name: "custom-token", pattern: /custom_[a-z0-9]+/g },
    ]);
    expect(count).toBe(1);
    expect(session.messages[0]?.text).toBe("token is [REDACTED:custom-token]");
  });

  it("previewRedactSession reports counts without mutating", () => {
    const session: CanonicalSession = {
      id: "test-2",
      source: "cursor",
      messages: [
        {
          turn: 1,
          role: "user",
          text: "AKIAIOSFODNN7EXAMPLE",
          toolCalls: [],
        },
      ],
      contentHash: "h",
    };
    const before = session.messages[0]?.text;
    const preview = previewRedactSession(session);
    expect(preview.count).toBe(1);
    expect(preview.byRule["aws-access-key-id"]).toBe(1);
    expect(session.messages[0]?.text).toBe(before);
  });
});
