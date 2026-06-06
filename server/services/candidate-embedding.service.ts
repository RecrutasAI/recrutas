/**
 * Compute and store candidate embedding (Gemini gemini-embedding-001, 384-dim).
 * Called after resume parsing and during batch backfill. Must share the same
 * provider/space as job embeddings (see server/ml-matching.ts).
 */

import { db, client } from '../db';
import { candidateProfiles } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { generateCandidateEmbedding } from '../ml-matching';

/**
 * Compute a candidate's embedding from skills + experience + job titles and persist it.
 * Non-blocking — callers should fire-and-forget with .catch().
 */
export async function updateCandidateEmbedding(
  userId: string,
  skills: string[],
  experience: string,
  previousJobTitles?: string[],
): Promise<void> {
  if (!skills || skills.length === 0) return;
  if (!process.env.GEMINI_API_KEY) {
    throw Object.assign(new Error('GEMINI_API_KEY not set'), { embeddingFailure: 'auth' });
  }

  const { embedding, failureReason } = await generateCandidateEmbedding(skills, experience, previousJobTitles);
  if (!embedding || embedding.length === 0) {
    // Loud failure: an empty vector means the provider returned nothing. Throw
    // (carrying the failure class) instead of silently returning so the backfill
    // counts it and a real outage surfaces — a silent return here is exactly what
    // let processed++ overcount while nothing was written. The fire-and-forget
    // resume-parse callers already swallow this with .catch().
    throw Object.assign(
      new Error(`Empty candidate embedding for ${userId} — provider returned no vector`),
      { embeddingFailure: failureReason ?? 'outage' },
    );
  }

  const vectorStr = `[${embedding.join(',')}]`;

  // Dual-write: TEXT column (legacy) + native pgvector column
  await client`
    UPDATE candidate_users
    SET vector_embedding = ${JSON.stringify(embedding)},
        embedding = ${vectorStr}::vector,
        embedding_updated_at = NOW()
    WHERE user_id = ${userId}
  `;

  console.log(`[CandidateEmbedding] Stored ${embedding.length}-dim vector for ${userId}`);
}

/**
 * Backfill embeddings for all candidates with skills but no embedding.
 * Called from batch-embeddings cron.
 */
export async function backfillCandidateEmbeddings(
  limit = 100,
): Promise<{ processed: number; errors: number; rateLimited: number }> {
  const { sql } = await import('drizzle-orm/sql');

  const candidates = await db.select()
    .from(candidateProfiles)
    .where(sql`
      ${candidateProfiles.vectorEmbedding} IS NULL
      AND jsonb_array_length(${candidateProfiles.skills}) > 0
    `)
    .limit(limit);

  let processed = 0;
  let errors = 0;
  let rateLimited = 0;

  for (const c of candidates) {
    try {
      // Extract job titles from resumeParsingData if available
      const parsingData = c.resumeParsingData as any;
      const titles = parsingData?.positions?.map((p: any) => p.title).filter(Boolean) || [];
      await updateCandidateEmbedding(
        c.userId,
        (c.skills || []) as string[],
        c.experience || '',
        titles,
      );
      processed++;
      // Small delay to ease provider rate limits
      await new Promise(r => setTimeout(r, 200));
    } catch (err: any) {
      // Routine quota throttling is not an outage; keep it separate so the cron
      // only goes red on real failures (see batch-embedding.service.ts guard).
      if (err?.embeddingFailure === 'rate_limit') rateLimited++;
      else errors++;
    }
  }

  console.log(`[CandidateEmbedding] Backfill: ${processed} computed, ${errors} errors, ${rateLimited} rate-limited`);
  return { processed, errors, rateLimited };
}
