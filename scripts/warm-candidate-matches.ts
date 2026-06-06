/**
 * Warm candidate match cache — standalone cron script
 * Pre-computes job recommendations for all candidates with skills.
 *
 * Usage: npx tsx scripts/warm-candidate-matches.ts
 */

import { storage } from '../server/storage.js';
import { client } from '../server/db.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';

async function main(): Promise<PipelineSummary> {
  console.log('[WarmMatches] Warming match cache for all candidates...');

  const allCandidates = await storage.getAllCandidateUsers();
  const withSkills = allCandidates.filter((c: any) => Array.isArray(c.skills) && c.skills.length > 0);

  console.log(`[WarmMatches] Found ${withSkills.length} candidates with skills (${allCandidates.length} total)`);

  let warmed = 0;
  for (const candidate of withSkills) {
    try {
      await storage.getJobRecommendations(candidate.userId);
      warmed++;
      await new Promise(r => setTimeout(r, 100));
    } catch (e: any) {
      console.warn(`[WarmMatches] Failed for ${candidate.userId}:`, e?.message);
    }
  }

  console.log(`[WarmMatches] Warmed ${warmed}/${withSkills.length} candidates`);
  return {
    status: warmed < withSkills.length ? 'warning' : 'ok',
    itemsProcessed: warmed,
    itemsFailed: withSkills.length - warmed,
    message: `warmed ${warmed}/${withSkills.length} candidates`,
  };
}

runAsPipeline('warm-candidate-matches', main)
  .then(() => { client?.end(); process.exit(0); })
  .catch((err) => { console.error('[WarmMatches] Fatal:', err); client?.end(); process.exit(1); });
