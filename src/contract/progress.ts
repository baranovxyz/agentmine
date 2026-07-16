const PROGRESS_THROTTLE_MS = 100;
let lastProgressAt = 0;

export interface ProgressEvent {
  event: "progress";
  phase: string;
  current?: number;
  total?: number;
  [key: string]: unknown;
}

/**
 * Emit a structured progress event to stderr as NDJSON, throttled to 10 Hz.
 * Agents can parse/filter; humans see a readable stream; neither sees ANSI.
 */
export function reportProgress(
  phase: string,
  extra: { current?: number; total?: number; [key: string]: unknown } = {},
): void {
  const now = Date.now();
  if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
  lastProgressAt = now;
  const ev: ProgressEvent = { event: "progress", phase, ...extra };
  process.stderr.write(JSON.stringify(ev) + "\n");
}

/** Force-emit a progress event ignoring the throttle (e.g. start/end markers). */
export function reportProgressImmediate(
  phase: string,
  extra: { [key: string]: unknown } = {},
): void {
  lastProgressAt = Date.now();
  process.stderr.write(
    JSON.stringify({ event: "progress", phase, ...extra }) + "\n",
  );
}
