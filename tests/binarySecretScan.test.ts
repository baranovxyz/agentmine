import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AllowedBinaryFinding,
  verifyBinarySecretScan,
} from "../scripts/verify-binary-secret-scan.mjs";

const TARGET = "bun-linux-x64-baseline";
const KNOWN_RAW = "known runtime bytes";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function finding(
  raw = KNOWN_RAW,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    DetectorName: "ExampleDetector",
    DecoderName: "UTF16",
    Verified: false,
    Raw: raw,
    RawV2: "",
    ...overrides,
  });
}

function allowlist(count = 1): Record<string, AllowedBinaryFinding[]> {
  return {
    [TARGET]: [
      {
        detector: "ExampleDetector",
        decoder: "UTF16",
        verified: false,
        rawSha256: sha256(KNOWN_RAW),
        rawLength: Buffer.byteLength(KNOWN_RAW, "utf8"),
        count,
      },
    ],
  };
}

describe("binary secret scan verifier", () => {
  it("accepts only the exact pinned runtime fingerprint and count", () => {
    expect(
      verifyBinarySecretScan({
        target: TARGET,
        exitCode: 183,
        findingsText: `${finding()}\n${finding()}\n`,
        stderrText: "",
        allowlist: allowlist(2),
      }),
    ).toEqual({ acceptedRuntimeFindings: 2 });
  });

  it("accepts a clean scanner result without an exception", () => {
    expect(
      verifyBinarySecretScan({
        target: TARGET,
        exitCode: 0,
        findingsText: "",
        stderrText: "",
        allowlist: allowlist(),
      }),
    ).toEqual({ acceptedRuntimeFindings: 0 });
  });

  it("rejects changed raw bytes without exposing them", () => {
    const unexpected = "unexpected runtime bytes";
    expect(() =>
      verifyBinarySecretScan({
        target: TARGET,
        exitCode: 183,
        findingsText: finding(unexpected),
        stderrText: "",
        allowlist: allowlist(),
      }),
    ).toThrow("unexpected secret-like finding");
    try {
      verifyBinarySecretScan({
        target: TARGET,
        exitCode: 183,
        findingsText: finding(unexpected),
        stderrText: "",
        allowlist: allowlist(),
      });
    } catch (error) {
      expect(String(error)).not.toContain(unexpected);
    }
  });

  it("rejects verified findings and count drift", () => {
    expect(() =>
      verifyBinarySecretScan({
        target: TARGET,
        exitCode: 183,
        findingsText: finding(KNOWN_RAW, { Verified: true }),
        stderrText: "",
        allowlist: allowlist(),
      }),
    ).toThrow("unexpected secret-like finding");
    expect(() =>
      verifyBinarySecretScan({
        target: TARGET,
        exitCode: 183,
        findingsText: finding(),
        stderrText: "",
        allowlist: allowlist(2),
      }),
    ).toThrow("does not match the pinned runtime");
  });

  it("rejects malformed output, scanner diagnostics, and operational exits", () => {
    expect(() =>
      verifyBinarySecretScan({
        target: TARGET,
        exitCode: 183,
        findingsText: "{not-json}\n",
        stderrText: "",
        allowlist: allowlist(),
      }),
    ).toThrow("not valid JSONL");
    expect(() =>
      verifyBinarySecretScan({
        target: TARGET,
        exitCode: 183,
        findingsText: finding(),
        stderrText: "scanner warning",
        allowlist: allowlist(),
      }),
    ).toThrow("operational diagnostics");
    expect(() =>
      verifyBinarySecretScan({
        target: TARGET,
        exitCode: 1,
        findingsText: "",
        stderrText: "",
        allowlist: allowlist(),
      }),
    ).toThrow("failed operationally");
  });
});
