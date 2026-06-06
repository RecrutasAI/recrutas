/**
 * Batch Embedding Service
 * Pre-computes vector embeddings for all active jobs
 * Run via GitHub Actions (cron) or on-demand
 * 
 * Benefits:
 * - Real-time matching just does cosine similarity on stored vectors
 * - No need to generate embeddings on every request
 * - Runs offline - no server required at runtime
 */

import { storage } from '../storage.js';
import { generateEmbedding, type EmbeddingFailureReason } from '../ml-matching.js';
import { db, client } from '../db.js';
import { jobPostings } from '../../shared/schema.js';
import { eq } from 'drizzle-orm';

// Concurrency per batch. Kept low because Node's fetch (undici) starts dropping
// simultaneous TLS connections to the Gemini endpoint past ~10 concurrent
// (UND_ERR_CONNECT_TIMEOUT). 10 tested 100% clean; 50 failed ~60% of calls.
const BATCH_SIZE = 10;

async function computeJobEmbedding(job: {
  id: number;
  title: string;
  company: string;
  description?: string;
  skills?: string[];
  requirements?: string[];
}): Promise<{ embedding: number[]; failureReason?: EmbeddingFailureReason }> {
  const text = [
    job.title,
    job.company,
    ...(job.skills || []),
    ...(job.requirements || []),
    job.description?.slice(0, 1000) || '',
  ].join(' ');

  const result = await generateEmbedding(text);
  return { embedding: result.embedding, failureReason: result.failureReason };
}

export async function updateJobEmbedding(jobId: number): Promise<void> {
  const job = await storage.getJobPosting(jobId);
  if (!job) {
    console.error(`[BatchEmbed] Job ${jobId} not found`);
    return;
  }

  const { embedding, failureReason } = await computeJobEmbedding(job);
  if (!embedding || embedding.length === 0) {
    // Loud failure: an empty vector means the embedding provider returned
    // nothing (e.g. depleted API credits / bad key). Throw instead of skipping
    // so callers — and the cron — surface it rather than silently no-op'ing.
    // A silent skip here is exactly what hid the HF 402 outage for 18 days.
    // Carry the failure class so the batch guard can tell quota throttling apart
    // from a real outage.
    throw Object.assign(
      new Error(`Empty embedding for job ${jobId} — embedding provider returned no vector (${failureReason ?? 'unknown'})`),
      { embeddingFailure: failureReason ?? 'outage' },
    );
  }
  const vectorStr = `[${embedding.join(',')}]`;

  // Dual-write: TEXT column (legacy) + native pgvector column
  await client`
    UPDATE job_postings
    SET vector_embedding = ${JSON.stringify(embedding)},
        embedding = ${vectorStr}::vector,
        embedding_updated_at = NOW()
    WHERE id = ${jobId}
  `;

  console.log(`[BatchEmbed] Updated embedding for job ${jobId}: ${job.title}`);
}

export async function batchComputeEmbeddings(
  limit: number = 500,
  forceRefresh: boolean = false
): Promise<{ processed: number; errors: number; rateLimited: number }> {
  console.log(`[BatchEmbed] Starting batch embedding computation (limit: ${limit})`);

  const startTime = Date.now();
  let processed = 0;
  let errors = 0;        // hard failures — credits/auth/outage (loud)
  let rateLimited = 0;   // routine free-tier quota 429s (expected, healthy)

  try {
    if (!db) throw new Error('Database not available');
    // Fetch all active jobs directly — storage.getJobPostings requires a talentOwnerId
    const allJobs = await db
      .select()
      .from(jobPostings)
      .where(eq(jobPostings.status, 'active'))
      .limit(limit);
    const activeJobs = allJobs;

    console.log(`[BatchEmbed] Processing ${activeJobs.length} active jobs`);

    for (let i = 0; i < activeJobs.length; i += BATCH_SIZE) {
      const batch = activeJobs.slice(i, i + BATCH_SIZE);
      
      await Promise.all(
        batch.map(async (job) => {
          try {
            const needsUpdate = forceRefresh || !job.vectorEmbedding;
            
            if (!needsUpdate) {
              const lastUpdate = job.embeddingUpdatedAt ? new Date(job.embeddingUpdatedAt).getTime() : 0;
              const daysSinceUpdate = (Date.now() - lastUpdate) / (1000 * 60 * 60 * 24);
              if (daysSinceUpdate < 7) {return;}
            }

            await updateJobEmbedding(job.id);
            processed++;
          } catch (err: any) {
            if (err?.embeddingFailure === 'rate_limit') {
              // Quota throttle — provider is healthy, just out of free-tier
              // budget for now. Don't count it as an error (would make the cron
              // flap red every run once the daily cap is hit).
              rateLimited++;
            } else {
              console.error(`[BatchEmbed] Error processing job ${job.id}:`, err);
              errors++;
            }
          }
        })
      );

      console.log(`[BatchEmbed] Processed ${Math.min(i + BATCH_SIZE, activeJobs.length)}/${activeJobs.length}`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[BatchEmbed] Completed in ${duration}s. Processed: ${processed}, Hard errors: ${errors}, Rate-limited: ${rateLimited}`);

    // Loud failure — turn the cron RED — ONLY on a genuine outage: a hard error
    // class (depleted credits, bad/blocked key, provider unreachable, malformed
    // response), NOT the routine free-tier quota 429s. We go red when EITHER (a)
    // we wrote nothing but hit hard errors, or (b) hard errors dominate the real
    // attempts. Pure quota throttling stays GREEN with a warning below, so the
    // GitHub failure email means "something is actually broken" rather than "we
    // hit the daily cap again" — otherwise the alert is noise and a real outage
    // gets ignored, which is the exact 18-day blind spot that started this.
    const hardAttempted = processed + errors;
    if (errors > 0 && (processed === 0 || errors / hardAttempted > 0.5)) {
      throw new Error(
        `[BatchEmbed] Embedding provider FAILING: ${errors} hard errors, only ${processed} written ` +
        `(${rateLimited} throttled). Likely depleted credits, a bad/blocked GEMINI_API_KEY, or a provider outage.`
      );
    }

    if (rateLimited > 0) {
      console.warn(
        `[BatchEmbed] ⚠️  ${rateLimited} jobs throttled by Gemini quota (free-tier daily cap); ` +
        `provider healthy, ${processed} written this run. Remaining jobs backfill on later runs — ` +
        `enable Gemini billing or switch to batchEmbedContents to clear the backlog faster.`
      );
    }

    return { processed, errors, rateLimited };
  } catch (err) {
    console.error('[BatchEmbed] Fatal error:', err);
    throw err;
  }
}

export async function findSimilarJobs(
  jobId: number,
  limit: number = 10
): Promise<Array<{ jobId: number; score: number; title: string; company: string }>> {
  if (!client) return [];

  // Use pgvector cosine distance for fast ANN similarity search
  const rows = await client`
    SELECT j2.id AS job_id, j2.title, j2.company,
           1 - (j1.embedding <=> j2.embedding) AS score
    FROM job_postings j1
    JOIN job_postings j2 ON j2.id != j1.id AND j2.embedding IS NOT NULL
    WHERE j1.id = ${jobId} AND j1.embedding IS NOT NULL AND j2.status = 'active'
    ORDER BY j1.embedding <=> j2.embedding
    LIMIT ${limit}
  `;

  return rows.map((r: any) => ({
    jobId: r.job_id,
    score: r.score,
    title: r.title,
    company: r.company,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('[BatchEmbed] Running as CLI script...');

  const limit = parseInt(process.env.BATCH_LIMIT || '500');
  const force = process.argv.includes('--force');

  const startedAt = new Date();
  (async () => {
    const { recordPipelineRun } = await import('./pipeline-run.service.js');
    try {
      // Job embeddings
      const jobResult = await batchComputeEmbeddings(limit, force);
      console.log('[BatchEmbed] Jobs done:', jobResult);

      // Candidate embeddings backfill
      const { backfillCandidateEmbeddings } = await import('./candidate-embedding.service.js');
      const candidateResult = await backfillCandidateEmbeddings(100);
      console.log('[BatchEmbed] Candidates done:', candidateResult);

      const processed = jobResult.processed + candidateResult.processed;
      const failed = jobResult.errors + candidateResult.errors;
      const throttled = jobResult.rateLimited + candidateResult.rateLimited;
      const stats = { jobResult, candidateResult };

      // Loud failure: a candidate-side wipeout from HARD errors (tried some, wrote
      // none, and the failures weren't mere quota throttling) means the provider is
      // down even if the job phase had nothing new to do. Exit red. A run that wrote
      // nothing purely because of quota 429s stays green — provider is healthy.
      if (candidateResult.errors > 0 && candidateResult.processed === 0) {
        const message = `All candidate embeddings failed with hard errors ` +
          `(${candidateResult.errors} errors, ${candidateResult.rateLimited} throttled) — provider down or out of credits.`;
        console.error(`[BatchEmbed] FAILED: ${message}`);
        await recordPipelineRun({ pipeline: 'batch-embeddings', status: 'failed', startedAt, itemsProcessed: processed, itemsFailed: failed, message, stats });
        process.exit(1);
      }

      // 'warning' when the provider is healthy but throttled by quota (expected on
      // the free tier); 'ok' otherwise. The job-phase hard-outage already threw above.
      const status = throttled > 0 ? 'warning' : 'ok';
      await recordPipelineRun({
        pipeline: 'batch-embeddings', status, startedAt,
        itemsProcessed: processed, itemsFailed: failed,
        message: `${processed} written, ${throttled} throttled, ${failed} hard errors`,
        stats,
      });
      process.exit(0);
    } catch (err: any) {
      console.error('[BatchEmbed] Failed:', err);
      await recordPipelineRun({ pipeline: 'batch-embeddings', status: 'failed', startedAt, message: err?.message ?? String(err) });
      process.exit(1);
    }
  })();
}
