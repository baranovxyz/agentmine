import { v7 as uuidv7 } from "uuid";
import {
  reportProgress,
  reportProgressImmediate,
} from "../contract/progress.js";
import type { DatabaseType } from "../db/client.js";
import type { EmbeddingChunk } from "./chunks.js";
import { buildEmbeddingChunks, serializeVector } from "./chunks.js";
import { createEmbeddingProvider } from "./providers.js";

interface SessionRow {
  id: string;
  source: string;
  project_path: string | null;
}

interface MessageRow {
  turn: number;
  role: "user" | "assistant" | "thinking" | "system" | "subagent";
  text: string;
}

interface ToolRow {
  turn: number;
  name: string;
  args_json: string | null;
  args_hash: string;
  args_preview: string | null;
  output_preview: string | null;
  exit_code: number | null;
}

export interface EmbedOptions {
  providerName: string;
  model: string;
  dryRun: boolean;
  limit: number;
  /** Only embed chunks from sessions started on/after this unix-epoch-seconds cutoff. */
  sinceEpoch?: number;
}

export interface EmbedResultData {
  run_id?: string;
  provider: string;
  model: string;
  model_id?: number;
  dimensions: number;
  dry_run: boolean;
  requested_limit?: number;
  planned_chunks: number;
  pending_chunks: number;
  processed_chunks: number;
  embedded_chunks: number;
  skipped_cached_chunks: number;
  skipped_secret_chunks: number;
  failed_chunks: number;
  estimated_tokens: number;
  would_call_provider: boolean;
  status: "completed" | "partial" | "failed";
}

export async function runEmbed(
  db: DatabaseType,
  options: EmbedOptions,
): Promise<EmbedResultData> {
  const provider = createEmbeddingProvider(options.providerName, options.model);
  const modelInfo = provider.modelInfo(options.model);
  const modelId = options.dryRun
    ? findEmbeddingModelId(db, modelInfo)
    : upsertEmbeddingModel(db, modelInfo);
  const plan = buildEmbeddingPlan(db, modelId, {
    persistChunks: !options.dryRun,
    sinceEpoch: options.sinceEpoch,
  });

  const requestedLimit = options.dryRun ? undefined : options.limit;
  const pending =
    requestedLimit === undefined
      ? plan.pending
      : plan.pending.slice(0, requestedLimit);

  if (options.dryRun) {
    return {
      provider: options.providerName,
      model: options.model,
      dimensions: modelInfo.dimensions,
      dry_run: true,
      planned_chunks: plan.totalChunks,
      pending_chunks: plan.pending.length,
      processed_chunks: 0,
      embedded_chunks: 0,
      skipped_cached_chunks: plan.skippedCached,
      skipped_secret_chunks: plan.skippedSecretChunks,
      failed_chunks: 0,
      estimated_tokens: plan.estimatedTokens,
      would_call_provider: false,
      status: "completed",
    };
  }

  const runId = `emb_${uuidv7()}`;
  const startedAt = nowSeconds();
  insertRun(db, {
    id: runId,
    provider: options.providerName,
    model: options.model,
    modelId: modelId!,
    status: "completed",
    requestedLimit: options.limit,
    plannedChunks: plan.totalChunks,
    estimatedTokens: plan.estimatedTokens,
    startedAt,
  });

  reportProgressImmediate("embed.start", {
    run_id: runId,
    provider: options.providerName,
    model: options.model,
    pending_chunks: pending.length,
  });

  let embeddedChunks = 0;
  let failedChunks = 0;
  for (let i = 0; i < pending.length; i += 1) {
    const chunk = pending[i]!;
    try {
      const [embedded] = await provider.embedDocuments([
        { id: String(chunk.id), text: chunk.retrieval_text },
      ]);
      if (!embedded) throw new Error("Provider returned no embedding");
      insertEmbedding(db, {
        chunkId: chunk.id,
        modelId: modelId!,
        vector: embedded.vector,
        tokenCount: embedded.tokenCount,
        providerRequestId: embedded.providerRequestId,
      });
      embeddedChunks += 1;
    } catch (e) {
      if (embeddedChunks === 0) {
        updateRun(db, runId, {
          status: "failed",
          processedChunks: i,
          embeddedChunks,
          skippedCachedChunks: plan.skippedCached,
          failedChunks: failedChunks + 1,
          finishedAt: nowSeconds(),
        });
        throw e;
      }
      failedChunks += 1;
      reportProgressImmediate("embed.chunk_failed", {
        chunk_id: chunk.id,
        error: (e as Error).message,
      });
    }
    reportProgress("embed", {
      current: i + 1,
      total: pending.length,
      embedded_chunks: embeddedChunks,
    });
  }

  const status = failedChunks > 0 ? "partial" : "completed";
  updateRun(db, runId, {
    status,
    processedChunks: pending.length,
    embeddedChunks,
    skippedCachedChunks: plan.skippedCached,
    failedChunks,
    finishedAt: nowSeconds(),
  });
  reportProgressImmediate("embed.done", {
    run_id: runId,
    status,
    embedded_chunks: embeddedChunks,
  });

  return {
    run_id: runId,
    provider: options.providerName,
    model: options.model,
    model_id: modelId,
    dimensions: modelInfo.dimensions,
    dry_run: false,
    requested_limit: options.limit,
    planned_chunks: plan.totalChunks,
    pending_chunks: plan.pending.length,
    processed_chunks: pending.length,
    embedded_chunks: embeddedChunks,
    skipped_cached_chunks: plan.skippedCached,
    skipped_secret_chunks: plan.skippedSecretChunks,
    failed_chunks: failedChunks,
    estimated_tokens: plan.estimatedTokens,
    would_call_provider: pending.length > 0,
    status,
  };
}

interface PlannedChunkRow {
  id: number;
  retrieval_text: string;
  token_estimate: number;
}

function buildEmbeddingPlan(
  db: DatabaseType,
  modelId: number | undefined,
  opts: { persistChunks: boolean; sinceEpoch?: number },
) {
  const sinceEpoch = opts.sinceEpoch;
  const sessions = (
    sinceEpoch === undefined
      ? db
          .prepare(
            `SELECT id, source, project_path FROM sessions ORDER BY started_at DESC, id`,
          )
          .all()
      : db
          .prepare(
            `SELECT id, source, project_path FROM sessions WHERE started_at >= ? ORDER BY started_at DESC, id`,
          )
          .all(sinceEpoch)
  ) as SessionRow[];
  let totalChunks = 0;
  let skippedSecretChunks = 0;
  let estimatedTokens = 0;

  const insertChunk = db.prepare(
    `INSERT OR IGNORE INTO embedding_chunks (
      session_id, start_turn, end_turn, chunk_index, source_kind, role_mix,
      chunker_version, redaction_version, content_hash, token_estimate,
      char_count, text_preview, retrieval_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const findCachedChunk =
    modelId === undefined
      ? undefined
      : db.prepare(
          `SELECT c.id
       FROM embedding_chunks c
       JOIN embeddings e ON e.chunk_id = c.id AND e.model_id = ?
      WHERE c.session_id = ?
        AND c.start_turn = ?
        AND c.end_turn = ?
        AND c.chunk_index = ?
        AND c.chunker_version = ?
        AND c.redaction_version = ?
        AND c.content_hash = ?
      LIMIT 1`,
        );
  const dryRunPending: PlannedChunkRow[] = [];
  let dryRunCached = 0;

  const transaction = db.transaction(() => {
    for (const session of sessions) {
      const chunks = buildEmbeddingChunks(
        loadSessionForChunking(db, session.id),
      );
      skippedSecretChunks += chunks.skippedSecretChunks;
      for (const chunk of chunks.chunks) {
        totalChunks += 1;
        estimatedTokens += chunk.tokenEstimate;
        if (opts.persistChunks) {
          insertChunk.run(
            chunk.sessionId,
            chunk.startTurn,
            chunk.endTurn,
            chunk.chunkIndex,
            chunk.sourceKind,
            chunk.roleMix,
            chunk.chunkerVersion,
            chunk.redactionVersion,
            chunk.contentHash,
            chunk.tokenEstimate,
            chunk.charCount,
            chunk.textPreview,
            chunk.retrievalText,
            nowSeconds(),
          );
        } else if (
          findCachedChunk?.get(
            modelId,
            chunk.sessionId,
            chunk.startTurn,
            chunk.endTurn,
            chunk.chunkIndex,
            chunk.chunkerVersion,
            chunk.redactionVersion,
            chunk.contentHash,
          )
        ) {
          dryRunCached += 1;
        } else {
          dryRunPending.push({
            id: -totalChunks,
            retrieval_text: chunk.retrievalText,
            token_estimate: chunk.tokenEstimate,
          });
        }
      }
    }
  });
  transaction();

  if (!opts.persistChunks) {
    return {
      totalChunks,
      pending: dryRunPending,
      skippedCached: dryRunCached,
      skippedSecretChunks,
      estimatedTokens,
    };
  }

  const sinceClause =
    sinceEpoch === undefined
      ? ""
      : ` AND c.session_id IN (SELECT id FROM sessions WHERE started_at >= ?)`;
  const sinceParams = sinceEpoch === undefined ? [] : [sinceEpoch];
  const pendingSql =
    modelId === undefined
      ? `SELECT c.id, c.retrieval_text, c.token_estimate
           FROM embedding_chunks c
          WHERE 1 = 1${sinceClause}
          ORDER BY c.id`
      : `SELECT c.id, c.retrieval_text, c.token_estimate
           FROM embedding_chunks c
          WHERE NOT EXISTS (
            SELECT 1 FROM embeddings e WHERE e.chunk_id = c.id AND e.model_id = ?
          )${sinceClause}
          ORDER BY c.id`;
  const pendingParams =
    modelId === undefined ? sinceParams : [modelId, ...sinceParams];
  const pending = db
    .prepare(pendingSql)
    .all(...pendingParams) as PlannedChunkRow[];
  const totalStored = (
    sinceEpoch === undefined
      ? db
          .prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(token_estimate), 0) AS tokens FROM embedding_chunks`,
          )
          .get()
      : db
          .prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(token_estimate), 0) AS tokens
               FROM embedding_chunks c
              WHERE c.session_id IN (SELECT id FROM sessions WHERE started_at >= ?)`,
          )
          .get(sinceEpoch)
  ) as { n: number; tokens: number };
  const skippedCached = Math.max(0, totalStored.n - pending.length);

  return {
    totalChunks: totalStored.n,
    pending,
    skippedCached,
    skippedSecretChunks,
    estimatedTokens: totalStored.tokens,
  };
}

function loadSessionForChunking(db: DatabaseType, sessionId: string) {
  const session = db
    .prepare(`SELECT id, source, project_path FROM sessions WHERE id = ?`)
    .get(sessionId) as SessionRow;
  const messages = db
    .prepare(
      `SELECT turn, role, text FROM messages WHERE session_id = ? ORDER BY turn`,
    )
    .all(sessionId) as MessageRow[];
  const tools = db
    .prepare(
      `SELECT turn, name, args_json, args_hash, args_preview, output_preview, exit_code
         FROM tool_calls WHERE session_id = ? ORDER BY turn, idx`,
    )
    .all(sessionId) as ToolRow[];
  const toolsByTurn = new Map<number, ToolRow[]>();
  for (const tool of tools) {
    const list = toolsByTurn.get(tool.turn) ?? [];
    list.push(tool);
    toolsByTurn.set(tool.turn, list);
  }
  return {
    id: session.id,
    source: session.source,
    projectPath: session.project_path ?? undefined,
    contentHash: "",
    messages: messages.map((message) => ({
      turn: message.turn,
      role: message.role,
      text: message.text,
      toolCalls: (toolsByTurn.get(message.turn) ?? []).map((tool) => ({
        name: tool.name,
        args: tool.args_json ? JSON.parse(tool.args_json) : undefined,
        argsHash: tool.args_hash,
        argsPreview: tool.args_preview ?? "",
        outputPreview: tool.output_preview ?? undefined,
        exitCode: tool.exit_code ?? undefined,
      })),
    })),
  };
}

function upsertEmbeddingModel(
  db: DatabaseType,
  model: { provider: string; model: string; dimensions: number },
): number {
  db.prepare(
    `INSERT OR IGNORE INTO embedding_models (provider, model, dimensions, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(model.provider, model.model, model.dimensions, nowSeconds());
  return (
    db
      .prepare(
        `SELECT id FROM embedding_models WHERE provider = ? AND model = ? AND dimensions = ?`,
      )
      .get(model.provider, model.model, model.dimensions) as { id: number }
  ).id;
}

function findEmbeddingModelId(
  db: DatabaseType,
  model: { provider: string; model: string; dimensions: number },
): number | undefined {
  return (
    db
      .prepare(
        `SELECT id FROM embedding_models WHERE provider = ? AND model = ? AND dimensions = ?`,
      )
      .get(model.provider, model.model, model.dimensions) as
      | { id: number }
      | undefined
  )?.id;
}

function insertEmbedding(
  db: DatabaseType,
  row: {
    chunkId: number;
    modelId: number;
    vector: Float32Array;
    tokenCount?: number;
    providerRequestId?: string;
  },
): void {
  const norm = Math.sqrt(
    row.vector.reduce((sum, value) => sum + value * value, 0),
  );
  db.prepare(
    `INSERT OR REPLACE INTO embeddings (
      chunk_id, model_id, vector, vector_norm, token_count, embedded_at, provider_request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.chunkId,
    row.modelId,
    serializeVector(row.vector),
    norm,
    row.tokenCount ?? null,
    nowSeconds(),
    row.providerRequestId ?? null,
  );
}

function insertRun(
  db: DatabaseType,
  row: {
    id: string;
    provider: string;
    model: string;
    modelId: number;
    status: string;
    requestedLimit: number;
    plannedChunks: number;
    estimatedTokens: number;
    startedAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO embedding_runs (
      id, provider, model, model_id, status, requested_limit, planned_chunks, estimated_tokens, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.provider,
    row.model,
    row.modelId,
    row.status,
    row.requestedLimit,
    row.plannedChunks,
    row.estimatedTokens,
    row.startedAt,
  );
}

function updateRun(
  db: DatabaseType,
  runId: string,
  row: {
    status: string;
    processedChunks: number;
    embeddedChunks: number;
    skippedCachedChunks: number;
    failedChunks: number;
    finishedAt: number;
  },
): void {
  db.prepare(
    `UPDATE embedding_runs
        SET status = ?,
            processed_chunks = ?,
            embedded_chunks = ?,
            skipped_cached_chunks = ?,
            failed_chunks = ?,
            finished_at = ?
      WHERE id = ?`,
  ).run(
    row.status,
    row.processedChunks,
    row.embeddedChunks,
    row.skippedCachedChunks,
    row.failedChunks,
    row.finishedAt,
    runId,
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export { upsertEmbeddingModel };
