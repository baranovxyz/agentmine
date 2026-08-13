export interface ColdImportCandidate {
  absolutePath: string;
  relativePath: string;
  size: number;
  identity: string;
  mtimeMs?: number;
  ctimeMs?: number;
  ino?: number;
  dev?: number;
}

export interface ColdImportStratum {
  stratum: number;
  eligible_files: number;
  eligible_bytes: number;
  selected_files: number;
  selected_bytes: number;
  min_bytes: number;
  max_bytes: number;
}

export interface ColdImportSelection {
  files: ColdImportCandidate[];
  eligibleFiles: number;
  eligibleBytes: number;
  selectedBytes: number;
  targetDeltaRatio: number;
  strata: ColdImportStratum[];
}

export interface AbbaSlot {
  block: number;
  position: number;
  runtime: "node" | "bun";
}

export interface ArtifactSnapshot {
  root: string;
  kind: "file" | "directory";
  files: number;
  bytes: number;
  sha256: string;
}

export interface StagedFixtureEntry {
  kind: "jsonl" | "metadata";
  ordinal?: number;
  relativePath: string;
  destination: string;
  size: number;
  sha256: string;
}

export interface StagedFixture {
  manifestSha256: string;
  treeManifestSha256: string;
  supplementalFiles: number;
  supplementalBytes: number;
  entries: StagedFixtureEntry[];
}

export const DEFAULT_TARGET_BYTES: number;
export const DEFAULT_SELECTED_FILES: number;
export const MIN_SELECTED_FILES: number;
export const DEFAULT_FREE_BYTES_FLOOR: number;
export const DEFAULT_DB_WAL_BYTE_CAP: number;
export const DEFAULT_REPETITIONS: number;

export function selectStratifiedFiles(
  input: ColdImportCandidate[],
  options: {
    selectedFiles: number;
    targetBytes: number;
    strataCount?: number;
    seedRatio?: number;
    toleranceRatio?: number;
  },
): ColdImportSelection;

export function buildAbbaSchedule(
  repetitions: number,
  aRuntime?: "node" | "bun",
): AbbaSlot[];

export function parseGnuTime(text: string): {
  wallSeconds: number;
  userSeconds: number;
  systemSeconds: number;
  maxRssKib: number;
  exitStatus: number;
};

export function pathIsWithin(parent: string, child: string): boolean;
export function assertWorkDirOutsideRepositories(
  workRoot: string,
  repositoryRoots: string[],
): void;
export function discoverRepositoryRoots(
  startDirectory: string,
  signal?: AbortSignal,
): Promise<{ currentRoot: string; repositoryRoots: string[] }>;
export function listClaudeRootJsonl(
  root: string,
  cutoffMs: number,
): Promise<ColdImportCandidate[]>;
export function dbWalBytes(dbPath: string): Promise<{
  dbBytes: number;
  walBytes: number;
  totalBytes: number;
}>;
export function assertReceiptDoesNotContainPaths(
  receipt: unknown,
  sensitivePaths: string[],
): void;
export function sanitizeErrorMessage(error: unknown): string;
export function snapshotArtifact(
  path: string,
  signal?: AbortSignal,
): Promise<ArtifactSnapshot>;
export function assertArtifactSnapshot(
  expected: ArtifactSnapshot,
  actual: ArtifactSnapshot,
  runtime: string,
): void;
export function stageFixture(
  selection: { files: ColdImportCandidate[] },
  fixtureRoot: string,
  mode: "hardlink" | "copy",
  freeBytesFloor: number,
  signal?: AbortSignal,
): Promise<StagedFixture>;
export function verifyStagedFixture(
  staged: StagedFixture,
  signal?: AbortSignal,
): Promise<void>;
export function createSignalHandler(
  controller: AbortController,
  terminate?: (signal: "SIGTERM" | "SIGKILL") => void,
  hardExit?: (code: number) => void,
): (signal: "SIGINT" | "SIGTERM") => void;
export function assertNormalizeAccounting(
  normalize: {
    processed: number;
    skipped_empty: number;
    skipped_up_to_date: number;
    skipped_unchanged: number;
    skipped_by_filter: number;
    failed: number;
  },
  rowCounts: { sessions?: number } | undefined,
  selectedFiles: number,
): void;
