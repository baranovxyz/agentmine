import { Errors } from "../contract/errors.js";
import type {
  EmbeddingModelInfo,
  EmbeddingProvider,
  EmbedInput,
  EmbedResult,
} from "./providers.js";

const OLLAMA_MODEL = "nomic-embed-text";
const OLLAMA_DIMENSIONS = 768;

// Self-healing clip-and-retry for over-context inputs (Ollama's `truncate`
// flag is unreliable on /api/embed). CLIP_FACTOR^MAX_CLIP_ATTEMPTS shrinks a
// ~6000-char chunk below ~600 chars, which fits even at ~1 token/char.
const CLIP_FACTOR = 0.7;
const MAX_CLIP_ATTEMPTS = 8;
const MIN_CLIP_CHARS = 256;
const CONTEXT_OVERFLOW_RE = /exceeds the context length|context length/i;

interface OllamaEmbedResponse {
  embeddings?: number[][];
  embedding?: number[];
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama";
  private readonly baseUrl: string;

  constructor(private readonly model: string) {
    if (model !== OLLAMA_MODEL) {
      throw Errors.invalidInput(
        `Ollama provider POC only supports model '${OLLAMA_MODEL}' (got '${model}')`,
      );
    }
    this.baseUrl = (
      process.env["AGENTMINE_OLLAMA_BASE_URL"] ?? "http://127.0.0.1:11434"
    ).replace(/\/$/, "");
  }

  modelInfo(model: string): EmbeddingModelInfo {
    if (model !== OLLAMA_MODEL) {
      throw Errors.invalidInput(
        `Ollama provider POC only supports model '${OLLAMA_MODEL}' (got '${model}')`,
      );
    }
    return {
      provider: this.name,
      model,
      dimensions: OLLAMA_DIMENSIONS,
      distance: "cosine",
    };
  }

  async embedDocuments(inputs: EmbedInput[]): Promise<EmbedResult[]> {
    const embeddings = await this.requestEmbeddings(
      inputs.map((input) => input.text),
    );
    return inputs.map((input, idx) => ({
      id: input.id,
      vector: normalizeVector(embeddings[idx] ?? []),
      tokenCount: Math.ceil(input.text.length / 4),
    }));
  }

  async embedQuery(input: string): Promise<EmbedResult> {
    const [embedding] = await this.requestEmbeddings([input]);
    return {
      id: "query",
      vector: normalizeVector(embedding ?? []),
      tokenCount: Math.ceil(input.length / 4),
    };
  }

  private async requestEmbeddings(inputs: string[]): Promise<number[][]> {
    // Embed one input per request so an over-context input can be clipped and
    // retried in isolation without poisoning a whole batch.
    const out: number[][] = [];
    for (const text of inputs) out.push(await this.embedSingle(text));
    return out;
  }

  private async embedSingle(text: string): Promise<number[]> {
    // Ollama's `truncate` flag does NOT reliably clip /api/embed inputs
    // (v0.24 returns HTTP 400 "input length exceeds the context length"
    // instead of truncating). Token density varies wildly across English,
    // Cyrillic, and code/diff text, so a char budget can't be predicted up
    // front. On a context-overflow 400 we clip the input ourselves and retry,
    // shrinking until it fits — this self-heals regardless of density.
    let body = text;
    for (let attempt = 0; attempt < MAX_CLIP_ATTEMPTS; attempt += 1) {
      const result = await this.postEmbed([body]);
      if (result.ok) {
        const embedding = result.embeddings[0];
        if (!embedding)
          throw Errors.internal("Ollama returned no embedding for input");
        return embedding;
      }
      if (
        result.status === 400 &&
        CONTEXT_OVERFLOW_RE.test(result.body) &&
        body.length > MIN_CLIP_CHARS
      ) {
        body = body.slice(
          0,
          Math.max(MIN_CLIP_CHARS, Math.floor(body.length * CLIP_FACTOR)),
        );
        continue;
      }
      if (result.status >= 500) {
        throw Errors.network(
          `Ollama embedding request failed with HTTP ${result.status}`,
        );
      }
      throw Errors.invalidInput(
        `Ollama embedding request failed with HTTP ${result.status}${result.body ? `: ${result.body.slice(0, 200)}` : ""}`,
      );
    }
    throw Errors.invalidInput(
      `Ollama could not embed an input even after clipping to ${MIN_CLIP_CHARS} chars`,
    );
  }

  private async postEmbed(inputs: string[]): Promise<{
    ok: boolean;
    status: number;
    embeddings: number[][];
    body: string;
  }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: inputs,
          truncate: true,
        }),
      });
    } catch {
      throw Errors.invalidInput(
        `Ollama is not reachable at ${this.baseUrl}. Install Ollama and run \`ollama pull ${OLLAMA_MODEL}\`, or use \`--provider fake\` for tests.`,
      );
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        embeddings: [],
        body: errorBody,
      };
    }

    const json = (await response.json()) as OllamaEmbedResponse;
    const embeddings =
      json.embeddings ?? (json.embedding ? [json.embedding] : []);
    if (embeddings.length !== inputs.length) {
      throw Errors.internal(
        `Ollama returned ${embeddings.length} embeddings for ${inputs.length} inputs`,
      );
    }
    return { ok: true, status: response.status, embeddings, body: "" };
  }
}

function normalizeVector(values: number[]): Float32Array {
  const vector = new Float32Array(values);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm > 0) {
    for (let i = 0; i < vector.length; i += 1) {
      vector[i] = vector[i]! / norm;
    }
  }
  return vector;
}
