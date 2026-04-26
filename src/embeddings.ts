/**
 * Embedding helper. Uses OpenAI text-embedding-3-small by default (1536 dims).
 *
 * For tests / dev without an API key, set ZBRAIN_EMBED_PROVIDER=fake to use
 * a deterministic hash-based fake embedding. Useful for E2E tests where
 * "did the right page come back" is the assertion, not "is the embedding
 * semantically meaningful."
 */
import OpenAI from "openai";
import { createHash } from "node:crypto";

export const EMBEDDING_DIM = 1536;
export const DEFAULT_MODEL = "text-embedding-3-small";

let _openaiClient: OpenAI | null = null;

function client(): OpenAI {
  if (_openaiClient) return _openaiClient;
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY not set. Set ZBRAIN_EMBED_PROVIDER=fake for offline testing.",
    );
  }
  _openaiClient = new OpenAI({ apiKey: key });
  return _openaiClient;
}

/**
 * Deterministic fake embedding for tests. Hash → seeded float distribution.
 * Same text always produces the same vector; semantically similar text does
 * NOT produce similar vectors (that's only true for real embeddings).
 */
function fakeEmbed(text: string): Float32Array {
  const hash = createHash("sha256").update(text).digest();
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    // Deterministic pseudo-random from hash bytes.
    const byte = hash[i % hash.length]!;
    v[i] = (byte / 255 - 0.5) * 0.2;
  }
  return v;
}

export async function embedOne(text: string): Promise<Float32Array> {
  if (process.env.ZBRAIN_EMBED_PROVIDER === "fake") {
    return fakeEmbed(text);
  }
  const model = process.env.ZBRAIN_EMBED_MODEL ?? DEFAULT_MODEL;
  const resp = await client().embeddings.create({
    model,
    input: text,
    encoding_format: "float",
  });
  const data = resp.data[0]?.embedding;
  if (!data || data.length !== EMBEDDING_DIM) {
    throw new Error(
      `Unexpected embedding shape from ${model}: got ${data?.length}, expected ${EMBEDDING_DIM}`,
    );
  }
  return Float32Array.from(data);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  if (process.env.ZBRAIN_EMBED_PROVIDER === "fake") {
    return texts.map(fakeEmbed);
  }
  const model = process.env.ZBRAIN_EMBED_MODEL ?? DEFAULT_MODEL;
  const resp = await client().embeddings.create({
    model,
    input: texts,
    encoding_format: "float",
  });
  return resp.data.map((d) => {
    if (d.embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `Unexpected embedding shape from ${model}: got ${d.embedding.length}, expected ${EMBEDDING_DIM}`,
      );
    }
    return Float32Array.from(d.embedding);
  });
}

export function currentEmbedModel(): string {
  if (process.env.ZBRAIN_EMBED_PROVIDER === "fake") return "fake";
  return process.env.ZBRAIN_EMBED_MODEL ?? DEFAULT_MODEL;
}
