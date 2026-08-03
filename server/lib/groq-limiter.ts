/**
 * Groq Rate Limiter + Circuit Breaker
 *
 * Coordinates all Groq API calls across the application with:
 * - Priority queue (critical > high > medium > low)
 * - Token bucket (5,000 tokens/min, 25 req/min — conservative below free tier limits)
 * - Circuit breaker (60s pause on 429, 5 min on 3 consecutive 429s)
 * - LRU cache (500 entries) for job summaries to avoid re-processing same descriptions
 */

import { createHash } from 'crypto';

export type GroqPriority = 'critical' | 'high' | 'medium' | 'low';

// Token bucket parameters (conservative below Groq free tier: 6k tokens/min, 30 req/min)
const TOKEN_BUCKET_CAPACITY = 5000;
const TOKEN_REFILL_RATE = 5000 / 60; // tokens per second
const REQ_BUCKET_CAPACITY = 25;
const REQ_REFILL_RATE = 25 / 60; // requests per second

// Safety net for the bucket wait below. Both buckets refill fully in 60s, so a
// satisfiable wait can never legitimately exceed that; anything longer means the
// pacing maths is wrong and we'd rather send the request than hang the process.
const MAX_BUCKET_WAIT_MS = 120_000;

const PRIORITY_ORDER: GroqPriority[] = ['critical', 'high', 'medium', 'low'];

interface QueueEntry<T> {
  fn: () => Promise<T>;
  priority: GroqPriority;
  estimatedTokens: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

// Token bucket state
let tokenBucket = TOKEN_BUCKET_CAPACITY;
let reqBucket = REQ_BUCKET_CAPACITY;
let lastRefillTime = Date.now();

// Circuit breaker state
let consecutive429s = 0;
let circuitPauseUntil = 0;

// Priority queues
const queue = new Map<GroqPriority, QueueEntry<any>[]>([
  ['critical', []],
  ['high', []],
  ['medium', []],
  ['low', []],
]);

let processingQueue = false;

function refillBuckets(): void {
  const now = Date.now();
  const elapsed = (now - lastRefillTime) / 1000; // seconds
  lastRefillTime = now;
  tokenBucket = Math.min(TOKEN_BUCKET_CAPACITY, tokenBucket + elapsed * TOKEN_REFILL_RATE);
  reqBucket = Math.min(REQ_BUCKET_CAPACITY, reqBucket + elapsed * REQ_REFILL_RATE);
}

function hasQueuedWork(): boolean {
  return PRIORITY_ORDER.some(p => (queue.get(p)?.length ?? 0) > 0);
}

async function processQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;

  try {
    while (hasQueuedWork()) {
      // Check circuit breaker
      const now = Date.now();
      if (now < circuitPauseUntil) {
        const waitMs = circuitPauseUntil - now;
        console.warn(`[GroqLimiter] Circuit breaker open — waiting ${Math.round(waitMs / 1000)}s`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }

      // Find next entry from highest priority non-empty queue
      let nextEntry: QueueEntry<any> | undefined;
      for (const priority of PRIORITY_ORDER) {
        const q = queue.get(priority)!;
        if (q.length > 0) {
          nextEntry = q.shift();
          break;
        }
      }

      if (!nextEntry) break;

      // Wait for token bucket capacity.
      //
      // A single request can legitimately want more than the bucket holds — a
      // 20K-char scrape prompt estimates at ~9,900 tokens against a 5,000
      // capacity. refillBuckets() clamps the bucket AT capacity, so reserving an
      // unclamped amount makes the loop below unsatisfiable: it spins on a timer
      // forever and takes the whole process with it (this is what killed every
      // scrape-tech-companies run once estimatedTokens went dynamic). Cap the
      // reservation at capacity — an oversized request drains the bucket and
      // goes, which still paces it correctly against the next one.
      refillBuckets();
      const requiredTokens = Math.min(nextEntry.estimatedTokens, TOKEN_BUCKET_CAPACITY);
      const waitDeadline = Date.now() + MAX_BUCKET_WAIT_MS;

      while (tokenBucket < requiredTokens || reqBucket < 1) {
        if (Date.now() >= waitDeadline) {
          console.warn(
            `[GroqLimiter] Bucket wait exceeded ${MAX_BUCKET_WAIT_MS}ms ` +
            `(need ${requiredTokens} tokens, have ${tokenBucket.toFixed(0)}) — proceeding anyway`,
          );
          break;
        }
        const tokenWait = tokenBucket < requiredTokens
          ? ((requiredTokens - tokenBucket) / TOKEN_REFILL_RATE) * 1000
          : 0;
        const reqWait = reqBucket < 1
          ? ((1 - reqBucket) / REQ_REFILL_RATE) * 1000
          : 0;
        const wait = Math.max(tokenWait, reqWait, 100);
        await new Promise(resolve => setTimeout(resolve, wait));
        refillBuckets();
      }

      // Consume from buckets
      tokenBucket -= requiredTokens;
      reqBucket -= 1;

      // Execute the request
      try {
        const result = await nextEntry.fn();
        consecutive429s = 0; // Reset on success
        nextEntry.resolve(result);
      } catch (error: any) {
        const is429 =
          error?.status === 429 ||
          error?.error?.type === 'requests_rate_limit_exceeded' ||
          (typeof error?.message === 'string' && (error.message.includes('429') || error.message.toLowerCase().includes('rate limit')));

        if (is429) {
          consecutive429s++;
          if (consecutive429s >= 3) {
            circuitPauseUntil = Date.now() + 5 * 60 * 1000;
            console.error('[GroqLimiter] Circuit breaker TRIPPED — 3 consecutive 429s, pausing 5 min');
          } else {
            circuitPauseUntil = Date.now() + 60 * 1000;
            console.warn(`[GroqLimiter] 429 received (${consecutive429s}/3) — pausing 60s`);
          }

          // Drop low-priority requests on rate limit; re-queue others
          if (nextEntry.priority === 'low') {
            nextEntry.reject(error);
          } else {
            queue.get(nextEntry.priority)!.unshift(nextEntry);
          }
        } else {
          nextEntry.reject(error);
        }
      }
    }
  } finally {
    processingQueue = false;
  }
}

/**
 * Wrap a Groq API call with priority queuing, token bucket throttling, and circuit breaker.
 *
 * @param fn - The function that makes the Groq API call
 * @param priority - Request priority: 'critical' (exam grading) | 'high' (resume parsing) | 'medium' (job summarization) | 'low' (scraping)
 * @param estimatedTokens - Estimated tokens this call will consume (default 1000)
 */
export function throttledGroqRequest<T>(
  fn: () => Promise<T>,
  priority: GroqPriority = 'medium',
  estimatedTokens: number = 1000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.get(priority)!.push({ fn, priority, estimatedTokens, resolve, reject });
    processQueue();
  });
}

// ---- LRU Cache for job summaries ----

const LRU_MAX_SIZE = 500;
const summaryCache = new Map<string, string>();

/**
 * Get a cached job summary by key (keyed by sha256 of first 500 chars of description).
 */
export function getCachedSummary(key: string): string | undefined {
  if (!summaryCache.has(key)) return undefined;
  // Move to end for LRU eviction order
  const value = summaryCache.get(key)!;
  summaryCache.delete(key);
  summaryCache.set(key, value);
  return value;
}

/**
 * Store a job summary in the LRU cache.
 */
export function setCachedSummary(key: string, value: string): void {
  if (summaryCache.size >= LRU_MAX_SIZE) {
    // Evict oldest entry
    const firstKey = summaryCache.keys().next().value;
    if (firstKey !== undefined) summaryCache.delete(firstKey);
  }
  summaryCache.set(key, value);
}

/**
 * Compute the cache key for a job description.
 */
export function summaryKey(description: string): string {
  return createHash('sha256').update(description.slice(0, 500)).digest('hex');
}

/**
 * Get limiter stats (for debugging/monitoring).
 */
export function getLimiterStats() {
  return {
    tokenBucket: Math.round(tokenBucket),
    reqBucket: Math.round(reqBucket),
    consecutive429s,
    circuitOpen: Date.now() < circuitPauseUntil,
    circuitPauseSecondsRemaining: Math.max(0, Math.round((circuitPauseUntil - Date.now()) / 1000)),
    queueLengths: Object.fromEntries(
      PRIORITY_ORDER.map(p => [p, queue.get(p)!.length])
    ),
    summaryCacheSize: summaryCache.size,
  };
}
