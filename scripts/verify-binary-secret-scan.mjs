#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const TRUFFLEHOG_FINDINGS_EXIT = 183;
const TARGETS = new Set([
  "bun-linux-x64-baseline",
  "bun-darwin-x64",
  "bun-darwin-arm64",
]);

export const BUN_RUNTIME_ALLOWLIST = Object.freeze({
  "bun-linux-x64-baseline": Object.freeze([
    Object.freeze({
      detector: "Aiven",
      decoder: "UTF16",
      verified: false,
      rawSha256:
        "104029b96582a017d699a9b65ff94a8369a4aa2de93556c0166c9516bb39b413",
      rawLength: 372,
      count: 1,
    }),
    Object.freeze({
      detector: "TomorrowIO",
      decoder: "UTF16",
      verified: false,
      rawSha256:
        "ae72ade24a789bff01c466fefc5174421e1434873cb414ee4b0dedf99302cbe6",
      rawLength: 32,
      count: 2,
    }),
  ]),
  "bun-darwin-x64": Object.freeze([]),
  "bun-darwin-arm64": Object.freeze([]),
});

class VerificationError extends Error {}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function findingKey(finding) {
  return JSON.stringify([
    finding.detector,
    finding.decoder,
    finding.verified,
    finding.rawSha256,
    finding.rawLength,
  ]);
}

function parseFindings(text) {
  const findings = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let decoded;
    try {
      decoded = JSON.parse(line);
    } catch {
      throw new VerificationError("secret scan output is not valid JSONL");
    }
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded) ||
      typeof decoded.DetectorName !== "string" ||
      typeof decoded.DecoderName !== "string" ||
      typeof decoded.Verified !== "boolean" ||
      typeof decoded.Raw !== "string" ||
      (decoded.RawV2 !== undefined &&
        decoded.RawV2 !== null &&
        decoded.RawV2 !== "")
    ) {
      throw new VerificationError("secret scan finding schema is invalid");
    }
    findings.push({
      detector: decoded.DetectorName,
      decoder: decoded.DecoderName,
      verified: decoded.Verified,
      rawSha256: sha256(decoded.Raw),
      rawLength: Buffer.byteLength(decoded.Raw, "utf8"),
    });
  }
  return findings;
}

export function verifyBinarySecretScan({
  target,
  exitCode,
  findingsText,
  stderrText,
  allowlist = BUN_RUNTIME_ALLOWLIST,
}) {
  if (!TARGETS.has(target)) {
    throw new VerificationError("unsupported standalone target");
  }
  if (!Number.isSafeInteger(exitCode) || exitCode < 0) {
    throw new VerificationError("secret scanner exit code is invalid");
  }
  if (stderrText.trim().length > 0) {
    throw new VerificationError("secret scanner emitted operational diagnostics");
  }

  const findings = parseFindings(findingsText);
  if (exitCode === 0) {
    if (findings.length > 0) {
      throw new VerificationError(
        "secret scanner reported findings with a success exit code",
      );
    }
    return { acceptedRuntimeFindings: 0 };
  }
  if (exitCode !== TRUFFLEHOG_FINDINGS_EXIT) {
    throw new VerificationError("secret scanner failed operationally");
  }
  if (findings.length === 0) {
    throw new VerificationError(
      "secret scanner reported a findings exit without findings",
    );
  }

  const expectedEntries = allowlist[target] ?? [];
  const expected = new Map(
    expectedEntries.map((entry) => [findingKey(entry), entry.count]),
  );
  const actual = new Map();
  for (const finding of findings) {
    const key = findingKey(finding);
    const expectedCount = expected.get(key);
    if (expectedCount === undefined) {
      throw new VerificationError(
        "standalone executable contains an unexpected secret-like finding",
      );
    }
    const next = (actual.get(key) ?? 0) + 1;
    if (next > expectedCount) {
      throw new VerificationError(
        "standalone executable contains an unexpected finding count",
      );
    }
    actual.set(key, next);
  }
  for (const [key, count] of expected) {
    if (actual.get(key) !== count) {
      throw new VerificationError(
        "standalone executable finding set does not match the pinned runtime",
      );
    }
  }
  return { acceptedRuntimeFindings: findings.length };
}

function parseOptions(args) {
  const options = {};
  const allowed = new Set([
    "--target",
    "--exit-code",
    "--findings",
    "--stderr",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !allowed.has(key) || value === undefined) {
      throw new VerificationError(`unknown or incomplete option: ${key ?? ""}`);
    }
    if (options[key] !== undefined) {
      throw new VerificationError(`duplicate option: ${key}`);
    }
    options[key] = value;
    index += 1;
  }
  for (const key of allowed) {
    if (options[key] === undefined) {
      throw new VerificationError(`${key} is required`);
    }
  }
  return options;
}

async function main(args) {
  const options = parseOptions(args);
  const target = options["--target"];
  const exitCode = Number(options["--exit-code"]);
  const result = verifyBinarySecretScan({
    target,
    exitCode,
    findingsText: await readFile(resolve(options["--findings"]), "utf8"),
    stderrText: await readFile(resolve(options["--stderr"]), "utf8"),
  });
  return { target, ...result };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const data = await main(process.argv.slice(2));
    process.stdout.write(
      `${JSON.stringify({
        version: 1,
        status: "success",
        command: "agentmine verify-binary-secret-scan",
        data,
        traceId: randomUUID(),
      })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        version: 1,
        status: "error",
        command: "agentmine verify-binary-secret-scan",
        data: null,
        errors: [
          {
            code: 2000,
            name: "SECRET_SCAN_VERIFICATION_FAILED",
            message: error instanceof Error ? error.message : "verification failed",
            category: "system",
            retryable: false,
          },
        ],
        traceId: randomUUID(),
      })}\n`,
    );
    process.exit(3);
  }
}
