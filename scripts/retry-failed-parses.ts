/**
 * Retry failed resume parses — standalone cron script
 * Retries up to 3 candidates per run with Gemini multimodal PDF parsing.
 *
 * Usage: npx tsx scripts/retry-failed-parses.ts
 */

import { storage } from '../server/storage.js';
import { client } from '../server/db.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';

async function main(): Promise<PipelineSummary> {
  console.log('[RetryParse] Looking for failed parses to retry...');

  const candidates = await storage.getCandidatesForParseRetry(3);
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
    // 4s delay between candidates — Gemini PDF multimodal is token-heavy
    if (i < candidates.length - 1) {
      await new Promise(r => setTimeout(r, 4000));
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
