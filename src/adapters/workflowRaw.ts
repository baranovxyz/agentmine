/**
 * Lossless raw ingest of the Claude Code Workflow tool's on-disk artifacts.
 *
 * Runs in the normalize phase. It scans the claude-code raw mirror for run
 * manifests (`<session>/workflows/wf_<id>.json`) and their journals
 * (`<session>/subagents/workflows/wf_<id>/journal.jsonl`) and stores both
 * verbatim in `raw_workflow_runs` / `raw_workflow_journal`. It does NOT decode
 * — the `workflows` extractor derives the fact tables from these raw rows via
 * the agent-canonical decoders. Storing verbatim is what lets the orchestration
 * layer outlive Claude Code's own transcript cleanup.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { DatabaseType } from "../db/client.js";
import {
  upsertWorkflowRunRaw,
  type WorkflowJournalLineRaw,
  workflowRunRawIsUpToDate,
} from "../db/writer.js";

const MANIFEST_RE = /^wf_.*\.json$/;

// Denormalized index hints pulled from each journal line; the full line is also
// stored verbatim. Permissive: a line that doesn't match yields null hints.
const JournalHintSchema = z
  .object({
    agentId: z.string().optional(),
    type: z.string().optional(),
    key: z.string().optional(),
  })
  .passthrough();

export interface WorkflowIngestResult {
  runs: number;
  skipped: number;
}

/**
 * Ingest all workflow runs found under `root` into the raw workflow tables.
 * Content-hash cached: an unchanged run (same manifest + journal bytes) is
 * skipped. Honors `dryRun` (counts without writing). Writes happen inside the
 * caller's write lock; each run is upserted in its own transaction.
 */
export async function ingestWorkflowRuns(
  db: DatabaseType,
  root: string,
  opts: { dryRun?: boolean } = {},
): Promise<WorkflowIngestResult> {
  const dryRun = opts.dryRun ?? false;
  const manifests: string[] = [];
  await collectManifests(root, manifests);

  let runs = 0;
  let skipped = 0;

  for (const manifestPath of manifests) {
    const runId = basename(manifestPath, ".json");
    // <root>/<project>/<sessionId>/workflows/wf_<id>.json → sessionId dir.
    const sessionDir = dirname(dirname(manifestPath));
    const orchestratingExternalId = basename(sessionDir);
    const journalPath = join(
      sessionDir,
      "subagents",
      "workflows",
      runId,
      "journal.jsonl",
    );

    let manifestJson: string;
    try {
      manifestJson = await readFile(manifestPath, "utf8");
    } catch {
      continue; // manifest vanished mid-scan; nothing to store.
    }
    const journalText = await readFile(journalPath, "utf8").catch(() => "");

    const contentHash = createHash("sha256")
      .update(manifestJson)
      .update("\0")
      .update(journalText)
      .digest("hex");

    if (workflowRunRawIsUpToDate(db, runId, contentHash)) {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      runs += 1;
      continue;
    }

    const journalLines = parseJournalLines(journalText);
    const tx = db.transaction(() => {
      upsertWorkflowRunRaw(db, {
        runId,
        source: "claude-code",
        orchestratingExternalId,
        rawPath: manifestPath,
        contentHash,
        manifestJson,
        journalLines,
      });
    });
    tx();
    runs += 1;
  }

  return { runs, skipped };
}

function parseJournalLines(journalText: string): WorkflowJournalLineRaw[] {
  const out: WorkflowJournalLineRaw[] = [];
  const lines = journalText.split("\n");
  lines.forEach((line, seq) => {
    if (line.length === 0) return;
    let agentId: string | null = null;
    let eventType: string | null = null;
    let key: string | null = null;
    try {
      const hint = JournalHintSchema.safeParse(JSON.parse(line));
      if (hint.success) {
        agentId = hint.data.agentId ?? null;
        eventType = hint.data.type ?? null;
        key = hint.data.key ?? null;
      }
    } catch {
      // Unparseable line still stored verbatim with null hints.
    }
    out.push({ seq, agentId, eventType, key, rawJson: line });
  });
  return out;
}

/**
 * Recursively collect workflow manifest paths. A manifest is a `wf_*.json` file
 * whose immediate parent directory is named `workflows` — which excludes the
 * `workflows/scripts/*.js` files and the `subagents/workflows/<id>/` journal
 * directories.
 */
async function collectManifests(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;
  const isWorkflowsDir = basename(dir) === "workflows";
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectManifests(full, out);
    } else if (
      entry.isFile() &&
      isWorkflowsDir &&
      MANIFEST_RE.test(entry.name)
    ) {
      out.push(full);
    }
  }
}
