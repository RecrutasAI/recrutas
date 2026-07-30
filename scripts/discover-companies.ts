/**
 * Discover and probe companies — standalone cron script
 * Phase 1: mine job postings for new company names
 * Phase 2: probe pending companies against ATS APIs
 * Phase 3: seed companies from Apollo.io
 *
 * Usage:
 *   npx tsx scripts/discover-companies.ts --phase=discover
 *   npx tsx scripts/discover-companies.ts --phase=probe [--limit=1500]
 *   npx tsx scripts/discover-companies.ts --phase=apollo
 */

import { db, client } from '../server/db.js';
import { eq } from 'drizzle-orm';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';

function parseArgs(): { phase: string; limit: number } {
  let phase = 'discover';
  let limit = 1500;
  for (const arg of process.argv.slice(2)) {
    const phaseMatch = arg.match(/^--phase=(\w+)$/);
    if (phaseMatch) phase = phaseMatch[1];
    const limitMatch = arg.match(/^--limit=(\d+)$/);
    if (limitMatch) limit = Math.min(parseInt(limitMatch[1], 10), 2000);
  }
  return { phase, limit };
}

async function main(): Promise<PipelineSummary> {
  if (!db) { console.error('[DiscoverCompanies] Database not available'); process.exit(1); }

  const { phase, limit } = parseArgs();
  console.log(`[DiscoverCompanies] Running phase: ${phase} (limit: ${limit})`);

  if (phase === 'discover') {
    const { companyDiscoveryPipeline } = await import('../server/company-discovery.js');
    await companyDiscoveryPipeline.runDiscovery();
    const stats = await companyDiscoveryPipeline.getStatistics();
    console.log('[DiscoverCompanies] Discovery complete:', JSON.stringify(stats, null, 2));
    return { status: 'ok', message: `discover phase complete`, stats: { phase, ...stats } };
  }

  if (phase === 'probe') {
    const { probePendingCompanies } = await import('../server/lib/ats-probe.js');
    const { discoveredCompanies: dcTable } = await import('../shared/schema.js');
    const results = await probePendingCompanies(limit);

    let approved = 0;
    let rejected = 0;
    let inconclusive = 0;
    for (const result of results) {
      if (result.inconclusive) {
        // Rate limited / provider paused — we never actually determined whether
        // this company has an ATS. Leave it `pending` so a later run retries it;
        // rejecting here would permanently drop a company we never checked.
        inconclusive++;
        continue;
      }
      if (result.atsType && result.atsId) {
        await db.update(dcTable)
          .set({
            detectedAts: result.atsType,
            atsId: result.atsId,
            careerPageUrl: result.careerPageUrl ?? undefined,
            status: 'approved',
            updatedAt: new Date(),
          })
          .where(eq(dcTable.normalizedName, result.normalizedName));
        approved++;
      } else {
        await db.update(dcTable)
          .set({ status: 'rejected', updatedAt: new Date() })
          .where(eq(dcTable.normalizedName, result.normalizedName));
        rejected++;
      }
    }
    console.log(`[DiscoverCompanies] Probe done: ${approved} approved, ${rejected} rejected, ${inconclusive} inconclusive (left pending)`);
    return {
      status: 'ok',
      itemsProcessed: approved + rejected,
      message: `probe: ${approved} approved, ${rejected} rejected, ${inconclusive} inconclusive`,
      stats: { phase, approved, rejected, inconclusive },
    };
  }

  if (phase === 'apollo') {
    const { runApolloDiscovery } = await import('../server/services/apollo-discovery.service.js');
    const apolloResult = await runApolloDiscovery(300);
    console.log('[DiscoverCompanies] Apollo done:', JSON.stringify(apolloResult, null, 2));
    return { status: 'ok', message: `apollo phase complete`, stats: { phase, ...apolloResult } };
  }

  console.error(`[DiscoverCompanies] Invalid phase: ${phase}. Use discover, probe, or apollo.`);
  process.exit(1);
}

runAsPipeline('discover-companies', main)
  .then(() => { client?.end(); process.exit(0); })
  .catch((err) => { console.error('[DiscoverCompanies] Fatal:', err); client?.end(); process.exit(1); });
