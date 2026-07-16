import { createHash } from "node:crypto";
import { Errors } from "../contract/errors.js";
import { OllamaEmbeddingProvider } from "./ollama.js";

export interface EmbeddingProvider {
  name: string;
  embedDocuments(inputs: EmbedInput[]): Promise<EmbedResult[]>;
  embedQuery(input: string): Promise<EmbedResult>;
  modelInfo(model: string): EmbeddingModelInfo;
}

export interface EmbedInput {
  id: string;
  text: string;
}

export interface EmbedResult {
  id: string;
  vector: Float32Array;
  tokenCount?: number;
  providerRequestId?: string;
}

export interface EmbeddingModelInfo {
  provider: string;
  model: string;
  dimensions: number;
  distance: "cosine";
  maxInputTokens?: number;
}

const FAKE_DIMENSIONS = 16;

export function createEmbeddingProvider(
  provider: string,
  model: string,
): EmbeddingProvider {
  if (provider === "fake") return new FakeEmbeddingProvider(model);
  if (provider === "ollama") return new OllamaEmbeddingProvider(model);
  throw Errors.invalidInput(`Unknown embedding provider '${provider}'`);
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fake";

  constructor(private readonly model: string) {
    if (model !== "fake") {
      throw Errors.invalidInput(
        "Fake embedding provider only supports model 'fake'",
      );
    }
  }

  modelInfo(model: string): EmbeddingModelInfo {
    if (model !== "fake") {
      throw Errors.invalidInput(
        "Fake embedding provider only supports model 'fake'",
      );
    }
    return {
      provider: this.name,
      model,
      dimensions: FAKE_DIMENSIONS,
      distance: "cosine",
    };
  }

  async embedDocuments(inputs: EmbedInput[]): Promise<EmbedResult[]> {
    return inputs.map((input) => ({
      id: input.id,
      vector: hashTextToVector(input.text, FAKE_DIMENSIONS),
      tokenCount: Math.ceil(input.text.length / 4),
    }));
  }

  async embedQuery(input: string): Promise<EmbedResult> {
    return {
      id: "query",
      vector: hashTextToVector(input, FAKE_DIMENSIONS),
      tokenCount: Math.ceil(input.length / 4),
    };
  }
}

function hashTextToVector(text: string, dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  const terms = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  for (const term of terms) {
    const digest = createHash("sha256").update(term).digest();
    const idx = digest[0]! % dimensions;
    const sign = digest[1]! % 2 === 0 ? 1 : -1;
    vector[idx] = (vector[idx] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm > 0) {
    for (let i = 0; i < vector.length; i += 1) {
      vector[i] = vector[i]! / norm;
    }
  }
  return vector;
}
