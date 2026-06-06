/**
 * ML-Based Job Matching Service
 * Uses Google Gemini embeddings (gemini-embedding-001) for semantic embeddings.
 * Output dimensionality is pinned to 384 (via Matryoshka truncation) to match the
 * existing pgvector(384) column and HNSW index — no schema migration needed when
 * switching providers. Both job and candidate embeddings share this single path,
 * so they stay in the same vector space.
 *
 * Previously used the HuggingFace Inference API; switched after HF free-tier
 * credits were depleted (HTTP 402), which silently zeroed out all new embeddings.
 */

const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const GEMINI_EMBED_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent`;
const EMBED_DIM = 384;

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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate embedding vector for text using HuggingFace Inference API.
 * Returns { embedding, tokens } to keep callers (vector-search, batch-embedding) working.
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  // Truncate to ~512 tokens (approx 2048 chars)
  const truncatedText = text.slice(0, 2048);
  const { values, failureReason } = await callGeminiAPI(truncatedText);
  return { embedding: values, tokens: values.length, failureReason };
}

/**
 * Generate embeddings for multiple texts sequentially.
 */
export async function generateBatchEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
  const results: EmbeddingResult[] = [];
  for (const text of texts) {
    results.push(await generateEmbedding(text));
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
