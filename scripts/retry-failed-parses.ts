/**
 * Retry failed resume parses — standalone cron script
 * Retries up to 3 candidates per run (RETRY_PARSE_LIMIT overrides): failed or
 * never-parsed résumés, and rule-engine parses left behind by an AI outage.
 *
 * Usage: npx tsx scripts/retry-failed-parses.ts
 */

import { storage } from '../server/storage.js';
import { client } from '../server/db.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';

async function main(): Promise<PipelineSummary> {
  console.log('[RetryParse] Looking for failed parses to retry...');

  // 3 per run (the cron runs hourly); RETRY_PARSE_LIMIT raises it for a one-off backfill.
  const limit = Math.max(1, Number(process.env.RETRY_PARSE_LIMIT) || 3);
  const candidates = await storage.getCandidatesForParseRetry(limit);
  if (candidates.length === 0) {
    console.log('[RetryParse] No failed parses to retry');
    return { status: 'ok', itemsProcessed: 0, message: 'no failed parses to retry' };
  }

  const { ResumeService } = await import('../server/services/resume.service.js');
  const { AIResumeParser } = await import('../server/ai-resume-parser.js');
  const resumeService = new ResumeService(storage, new AIResumeParser());

  let succeeded = 0;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const result = await resumeService.retryFailedParse(candidate.userId, candidate.resumeUrl!);
    if (result.success) succeeded++;
    console.log(`  [${i + 1}/${candidates.length}] userId=${candidate.userId} success=${result.success} skills=${result.skills}`);
    // A résumé is ~3,000 Groq tokens against a free tier of 8,000/min. At the
    // old 4s gap the third one queued in the limiter past the parser's 15s AI
    // race, and every résumé after it fell to the rule engine (5 of 10 on
    // 2026-10-02). 30s lets the bucket refill.
    if (i < candidates.length - 1) {
      await new Promise(r => setTimeout(r, 30_000));
    }
  }

  console.log(`[RetryParse] Retried ${candidates.length}, succeeded: ${succeeded}`);
  return {
    status: succeeded < candidates.length ? 'warning' : 'ok',
    itemsProcessed: succeeded,
    itemsFailed: candidates.length - succeeded,
    message: `retried ${candidates.length}, succeeded ${succeeded}`,
  };
}

runAsPipeline('retry-failed-parses', main)
  .then(() => { client?.end(); process.exit(0); })
  .catch((err) => { console.error('[RetryParse] Fatal:', err); client?.end(); process.exit(1); });
