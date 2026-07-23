export interface AllowedBinaryFinding {
  detector: string;
  decoder: string;
  verified: boolean;
  rawSha256: string;
  rawLength: number;
  count: number;
}

export interface BinarySecretScanOptions {
  target:
    | "bun-linux-x64-baseline"
    | "bun-darwin-x64"
    | "bun-darwin-arm64";
  exitCode: number;
  findingsText: string;
  stderrText: string;
  allowlist?: Readonly<Record<string, readonly AllowedBinaryFinding[]>>;
}

export interface BinarySecretScanResult {
  acceptedRuntimeFindings: number;
}

export const BUN_RUNTIME_ALLOWLIST: Readonly<
  Record<string, readonly AllowedBinaryFinding[]>
>;

export function verifyBinarySecretScan(
  options: BinarySecretScanOptions,
): BinarySecretScanResult;
