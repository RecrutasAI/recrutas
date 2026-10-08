/**
 * Warm candidate match cache — standalone cron script
 * Pre-computes job recommendations for all candidates with skills, which fills
 * the per-candidate feed cache (feed-cache.service.ts), and drops cache entries
 * nobody has refreshed in 48 hours.
 *
 * Usage: npx tsx scripts/warm-candidate-matches.ts
 */

import { storage } from '../server/storage.js';
import { client } from '../server/db.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';
import { purgeFeedCache } from '../server/services/feed-cache.service.js';

async function main(): Promise<PipelineSummary> {
  console.log('[WarmMatches] Warming match cache for all candidates...');
  const purged = await purgeFeedCache(48).catch((e: any) => { console.warn('[WarmMatches] cache purge failed:', e?.message); return 0; });

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
    message: `warmed ${warmed}/${withSkills.length} candidates, purged ${purged} stale cache entries`,
  };
}

runAsPipeline('warm-candidate-matches', main)
  .then(() => { client?.end(); process.exit(0); })
  .catch((err) => { console.error('[WarmMatches] Fatal:', err); client?.end(); process.exit(1); });
