export interface ReleaseIdentity {
  version: string;
  sourceCommit: string;
  bunVersion: string;
}

export interface PackageStandaloneOptions extends ReleaseIdentity {
  binary: string;
  target: string;
  outputDir: string;
}

export interface ReleaseManifestOptions extends ReleaseIdentity {
  artifactsDir: string;
  manifest: string;
  checksums: string;
}

export interface ReleaseArtifact {
  target: string;
  filename: string;
  size: number;
  sha256: string;
}

export interface ReleaseManifest {
  schema_version: 1;
  agentmine_version: string;
  source_commit: string;
  bun_version: string;
  artifacts: ReleaseArtifact[];
}

export const TARGETS: readonly {
  target: string;
  platform: string;
}[];

export function packageStandalone(
  options: PackageStandaloneOptions,
): Promise<
  ReleaseArtifact & {
    archive: string;
  }
>;

export function createReleaseManifest(
  options: ReleaseManifestOptions,
): Promise<ReleaseManifest>;

export function verifyReleaseManifest(
  options: ReleaseManifestOptions,
): Promise<ReleaseManifest>;
