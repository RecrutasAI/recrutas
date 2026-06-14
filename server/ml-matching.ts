/**
 * ML-Based Job Matching Service — semantic embeddings, 384-dim.
 *
 * Provider is selected by EMBED_PROVIDER:
 *   - gemini (default): Google `gemini-embedding-001`, output pinned to 384 via
 *     Matryoshka truncation. Metered — free tier caps embedded contents/day.
 *   - local: `bge-small-en-v1.5` run in-process via Transformers.js (ONNX). No
 *     API, key, or quota; natively 384-dim. Self-hosted on the VPS.
 *
 * Both emit 384-dim L2-normalized vectors, so the pgvector(384) column + HNSW
 * index are unchanged across providers. They are DIFFERENT vector spaces though:
 * switching requires a one-time full re-embed of all jobs + candidates (vectors
 * from different providers can't be mixed in one ANN index). Job and candidate
 * embeddings share this path so they always match the active provider's space.
 *
 * History: HuggingFace Inference API → Gemini (HF 402, depleted credits, silent
 * zeroing) → local bge-small added to drop the metered dependency entirely.
 */

const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const GEMINI_EMBED_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent`;
const GEMINI_BATCH_EMBED_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:batchEmbedContents`;
const EMBED_DIM = 384;

// Max texts per batchEmbedContents request. One HTTP request embeds the whole
// chunk, so this is the ~100x request-count reduction vs. per-item embedContent
// that keeps the backfill inside the free-tier daily request cap (RPD).
const EMBED_BATCH_SIZE = 100;

// ── Provider selection ────────────────────────────────────────────────────────
// EMBED_PROVIDER=gemini (default) uses the metered Gemini API; EMBED_PROVIDER=local
// runs bge-small-en-v1.5 in-process via Transformers.js (ONNX) — no API, no quota,
// no key. Both emit 384-dim L2-normalized vectors, so they're swappable WITHOUT a
// schema/index change. They are DIFFERENT vector spaces, though: switching providers
// requires a one-time full re-embed of every job + candidate (they can't be mixed in
// one ANN index). Read at call time (not module load) so env is set by then.
function embedProvider(): 'gemini' | 'local' {
  return (process.env.EMBED_PROVIDER || 'gemini').toLowerCase() === 'local' ? 'local' : 'gemini';
}

// Local model: 384-dim, same as the pinned Gemini output, so the pgvector(384)
// column + HNSW index are unchanged. Override with LOCAL_EMBED_MODEL.
const LOCAL_EMBED_MODEL = process.env.LOCAL_EMBED_MODEL || 'Xenova/bge-small-en-v1.5';
// Texts per forward pass when batching locally. Bounds peak memory; there is no
// rate limit, so this is purely a throughput/memory knob (unlike EMBED_BATCH_SIZE).
const LOCAL_BATCH_SIZE = parseInt(process.env.LOCAL_BATCH_SIZE || '32');

// Lazy singleton: the ONNX pipeline (and onnxruntime-node/sharp) load only when the
// local provider is actually used, so a gemini-only server never pulls them in.
//
// The specifier is held in a variable rather than a string literal so static
// dependency tracers (@vercel/nft, via esbuild --packages=external) cannot follow
// it. Otherwise the ~800MB onnxruntime-node/transformers tree gets bundled into the
// Vercel serverless function and blows past the 250MB limit, even though prod runs
// EMBED_PROVIDER=gemini and only the VPS crons ever use the local model. Runtime
// resolution in local mode is unaffected — Node resolves the variable normally.
const LOCAL_EMBED_PKG = '@huggingface/transformers';
let localExtractorPromise: Promise<any> | null = null;
function getLocalExtractor(): Promise<any> {
  if (!localExtractorPromise) {
    localExtractorPromise = (async () => {
      const { pipeline } = await import(/* @vite-ignore */ LOCAL_EMBED_PKG);
      console.log(`[ML Matching] Loading local embedding model ${LOCAL_EMBED_MODEL}…`);
      return pipeline('feature-extraction', LOCAL_EMBED_MODEL);
    })();
  }
  return localExtractorPromise;
}

// Embed a chunk of texts locally in one forward pass. bge-small with
// pooling:'mean' + normalize:true returns 384-dim unit vectors (no l2normalize
// needed). No quota, so any failure is a real 'outage' — never 'rate_limit'.
async function callLocalBatchAPI(
  texts: string[],
): Promise<Array<{ values: number[]; failureReason?: EmbeddingFailureReason }>> {
  try {
    const extractor = await getLocalExtractor();
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    const dim = out.dims[out.dims.length - 1];
    const flat = out.data as Float32Array; // shape [texts.length, dim], row-major
    return texts.map((_, i) => ({
      values: Array.from(flat.slice(i * dim, (i + 1) * dim)),
    }));
  } catch (error) {
    console.warn(`[ML Matching] Local embedding failed (${LOCAL_EMBED_MODEL}):`, (error as Error).message);
    return texts.map(() => ({ values: [], failureReason: 'outage' as EmbeddingFailureReason }));
  }
}

async function callLocalAPI(
  text: string,
): Promise<{ values: number[]; failureReason?: EmbeddingFailureReason }> {
  const [result] = await callLocalBatchAPI([text]);
  return result;
}

// How an embedding call failed, so batch callers can tell routine free-tier
// quota throttling ('rate_limit' — expected, provider healthy) apart from a
// real outage ('auth' = bad/blocked/missing key; 'outage' = depleted credits,
// provider down/unreachable, or a malformed response) that must turn the cron
// RED. Anything not clearly a rate-limit is treated as 'outage' so a genuine
// break is never silently downgraded to "just throttled".
export type EmbeddingFailureReason = 'rate_limit' | 'auth' | 'outage';

interface EmbeddingResult {
  embedding: number[];
  tokens: number;
  // Set only when `embedding` is empty. Undefined on success.
  failureReason?: EmbeddingFailureReason;
}

function classifyHttpStatus(status: number): EmbeddingFailureReason {
  if (status === 429) return 'rate_limit';            // quota / rate limit — expected on free tier
  if (status === 401 || status === 403) return 'auth'; // bad or blocked API key
  return 'outage';                                     // 402 credits, 4xx, 5xx, anything else
}

// Gemini returns non-normalized vectors when outputDimensionality < 3072.
// L2-normalize so the stored TEXT vector and JS cosineSimilarity stay consistent
// (pgvector's cosine ops normalize internally, but the legacy path does not).
function l2normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map(v => v / norm);
}

// ── Gemini embeddings API call with retry ─────────────────────────────────────

async function callGeminiAPI(
  text: string,
  attempt = 0,
): Promise<{ values: number[]; failureReason?: EmbeddingFailureReason }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[ML Matching] GEMINI_API_KEY not set — returning empty embedding');
    return { values: [], failureReason: 'auth' };
  }

  // Default to 'outage' so a thrown network error (fetch rejects before we read a
  // status) is classified as a real outage, not a soft throttle.
  let failureReason: EmbeddingFailureReason = 'outage';
  try {
    const response = await fetch(`${GEMINI_EMBED_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${GEMINI_EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType: 'SEMANTIC_SIMILARITY',
        outputDimensionality: EMBED_DIM,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      failureReason = classifyHttpStatus(response.status);
      throw new Error(`Gemini API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const values = data?.embedding?.values;
    if (Array.isArray(values) && values.length > 0) {
      return { values: l2normalize(values.map(Number)) };
    }

    console.warn('[ML Matching] Unexpected Gemini API response shape:', typeof data);
    return { values: [], failureReason: 'outage' };
  } catch (error) {
    if (attempt < 2) {
      const delay = (attempt + 1) * 1000;
      console.warn(`[ML Matching] Gemini API attempt ${attempt + 1} failed, retrying in ${delay}ms:`, (error as Error).message);
      await new Promise(r => setTimeout(r, delay));
      return callGeminiAPI(text, attempt + 1);
    }
    console.warn(`[ML Matching] Gemini API failed after 3 attempts (${failureReason}) — returning empty embedding:`, (error as Error).message);
    return { values: [], failureReason };
  }
}

// ── Gemini BATCH embeddings call with retry ───────────────────────────────────
// Embeds up to EMBED_BATCH_SIZE texts in a single HTTP request via
// batchEmbedContents. Returns one entry per input text, in order. On a failed
// request the whole chunk gets an empty `values` plus the classified
// failureReason so callers can count quota throttles apart from real outages —
// same contract as the single-item path, just amortized over the chunk.
async function callGeminiBatchAPI(
  texts: string[],
  attempt = 0,
): Promise<Array<{ values: number[]; failureReason?: EmbeddingFailureReason }>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[ML Matching] GEMINI_API_KEY not set — returning empty embeddings');
    return texts.map(() => ({ values: [], failureReason: 'auth' as EmbeddingFailureReason }));
  }

  let failureReason: EmbeddingFailureReason = 'outage';
  try {
    const response = await fetch(`${GEMINI_BATCH_EMBED_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map(text => ({
          model: `models/${GEMINI_EMBED_MODEL}`,
          content: { parts: [{ text }] },
          taskType: 'SEMANTIC_SIMILARITY',
          outputDimensionality: EMBED_DIM,
        })),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      failureReason = classifyHttpStatus(response.status);
      throw new Error(`Gemini batch API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const embeddings = data?.embeddings;
    if (Array.isArray(embeddings) && embeddings.length === texts.length) {
      return embeddings.map((e: any) => {
        const values = e?.values;
        return Array.isArray(values) && values.length > 0
          ? { values: l2normalize(values.map(Number)) }
          : { values: [], failureReason: 'outage' as EmbeddingFailureReason };
      });
    }

    console.warn(
      `[ML Matching] Unexpected Gemini batch response: expected ${texts.length} embeddings, got ${Array.isArray(embeddings) ? embeddings.length : typeof embeddings}`,
    );
    return texts.map(() => ({ values: [], failureReason: 'outage' as EmbeddingFailureReason }));
  } catch (error) {
    if (attempt < 2) {
      const delay = (attempt + 1) * 1000;
      console.warn(`[ML Matching] Gemini batch attempt ${attempt + 1} failed, retrying in ${delay}ms:`, (error as Error).message);
      await new Promise(r => setTimeout(r, delay));
      return callGeminiBatchAPI(texts, attempt + 1);
    }
    console.warn(`[ML Matching] Gemini batch failed after 3 attempts (${failureReason}) — returning empty embeddings:`, (error as Error).message);
    return texts.map(() => ({ values: [], failureReason }));
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a 384-dim embedding for text via the configured provider
 * (EMBED_PROVIDER=gemini|local). Returns { embedding, tokens, failureReason }
 * to keep callers (vector-search, batch-embedding) working.
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  // Truncate to ~512 tokens (approx 2048 chars)
  const truncatedText = text.slice(0, 2048);
  const { values, failureReason } = embedProvider() === 'local'
    ? await callLocalAPI(truncatedText)
    : await callGeminiAPI(truncatedText);
  return { embedding: values, tokens: values.length, failureReason };
}

/**
 * Generate embeddings for multiple texts using the Gemini batch endpoint.
 * Chunks into EMBED_BATCH_SIZE-sized requests (one HTTP call each) and returns
 * one EmbeddingResult per input text, in the same order. Failed chunks yield
 * empty embeddings carrying the failureReason so batch callers can distinguish
 * quota throttling from a real outage.
 */
export async function generateBatchEmbeddings(
  texts: string[],
  opts?: { delayMsBetweenChunks?: number },
): Promise<EmbeddingResult[]> {
  // Local provider: in-process, no quota → no pacing, no rate-limit bail. Just
  // run forward passes of LOCAL_BATCH_SIZE to bound memory.
  if (embedProvider() === 'local') {
    const results: EmbeddingResult[] = [];
    for (let i = 0; i < texts.length; i += LOCAL_BATCH_SIZE) {
      const chunk = texts.slice(i, i + LOCAL_BATCH_SIZE).map(t => t.slice(0, 2048));
      const chunkResults = await callLocalBatchAPI(chunk);
      for (const { values, failureReason } of chunkResults) {
        results.push({ embedding: values, tokens: values.length, failureReason });
      }
    }
    return results;
  }

  // Gemini's free tier caps embedded *contents* (not HTTP requests) at 100/min,
  // so a 100-text batch consumes the whole minute's budget. Pace chunks apart so
  // a multi-chunk run writes everything instead of throttling to zero after the
  // first chunk. Caller passes 0 (default) when the work fits one chunk.
  const delay = opts?.delayMsBetweenChunks ?? 0;
  const results: EmbeddingResult[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    if (i > 0 && delay > 0) await new Promise(r => setTimeout(r, delay));
    const chunk = texts.slice(i, i + EMBED_BATCH_SIZE).map(t => t.slice(0, 2048));
    const chunkResults = await callGeminiBatchAPI(chunk);
    for (const { values, failureReason } of chunkResults) {
      results.push({ embedding: values, tokens: values.length, failureReason });
    }

    // Once a whole chunk comes back rate-limited, the daily free-tier quota is
    // spent — every remaining chunk would just 429 after 3 retries and a 62s
    // pace wait (≈52 min of no-op grinding for a 5000-job cron run). Stop here
    // and mark the rest rate_limited so callers count them as throttled (green),
    // not as work that succeeded.
    const chunkRateLimited =
      chunkResults.length > 0 &&
      chunkResults.every(r => r.values.length === 0 && r.failureReason === 'rate_limit');
    if (chunkRateLimited) {
      for (let j = i + EMBED_BATCH_SIZE; j < texts.length; j++) {
        results.push({ embedding: [], tokens: 0, failureReason: 'rate_limit' });
      }
      break;
    }
  }
  return results;
}

/**
 * Calculate cosine similarity between two embedding vectors.
 * Returns value between 0 (no similarity) and 1 (identical).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    if (a.length !== b.length && a.length > 0 && b.length > 0) {
      console.warn('[ML Matching] Embedding dimensions mismatch, returning 0');
    }
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) { return 0; }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Generate a reusable candidate embedding from skills + experience + job titles.
 * Compute once and pass into calculateMLMatchScore for each job.
 *
 * Job titles are placed first in the text to give them high prominence in the
 * embedding — BGE-M3 (and most embedding models) weight earlier tokens more.
 */
export async function generateCandidateEmbedding(
  candidateSkills: string[],
  candidateExperience: string,
  previousJobTitles?: string[],
): Promise<EmbeddingResult> {
  // Front-load job titles so the embedding strongly represents the candidate's role identity
  const titleBlock = previousJobTitles && previousJobTitles.length > 0
    ? previousJobTitles.join(', ') + '. '
    : '';
  const candidateText = [
    titleBlock,
    ...candidateSkills,
    candidateExperience || '',
  ].join(' ').trim();
  return generateEmbedding(candidateText);
}

/**
 * Get model info
 */
export function getModelInfo() {
  return {
    model: GEMINI_EMBED_MODEL,
    description: 'Gemini gemini-embedding-001 — 384-dim (Matryoshka-truncated), L2-normalized, semantic similarity',
    dimensions: EMBED_DIM,
    maxTokens: 2048,
    type: 'Google Gemini Embeddings API',
    endpoint: GEMINI_EMBED_URL,
  };
}
