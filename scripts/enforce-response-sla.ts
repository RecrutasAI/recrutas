/**
 * Enforce 24h Response SLA — standalone cron script
 * Finds applications where candidate passed exam but recruiter hasn't acted
 * within 24h, marks them as rejected, and notifies the candidate.
 *
 * Usage: npx tsx scripts/enforce-response-sla.ts
 */

import { storage } from '../server/storage.js';
import { notificationService } from '../server/notification-service.js';
import { client } from '../server/db.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';

async function main(): Promise<PipelineSummary> {
  console.log('[SLA] Starting 24h response SLA enforcement...');

  const overdue = await storage.getOverdueExamApplications();
  if (overdue.length === 0) {
    console.log('[SLA] No overdue applications');
    return { status: 'ok', itemsProcessed: 0, message: 'no overdue applications' };
  }

  let closed = 0;
  for (const { applicationId, candidateId, jobTitle, company } of overdue) {
    try {
      await storage.updateApplicationStatusByCandidate(applicationId, 'rejected');
      await notificationService.createNotification({
        userId: candidateId,
        type: 'application_rejected',
        title: 'Application Closed — No Response',
        message: `${company} did not respond to your ${jobTitle} application within 24 hours. The application has been automatically closed.`,
        priority: 'high',
        relatedApplicationId: applicationId,
        data: { jobTitle, company, reason: 'sla_expired' },
      });
      closed++;
    } catch (err) {
      console.error(`[SLA] Failed to close application ${applicationId}:`, (err as Error).message);
    }
  }

  console.log(`[SLA] Closed ${closed}/${overdue.length} overdue applications`);
  return {
    status: closed < overdue.length ? 'warning' : 'ok',
    itemsProcessed: closed,
    itemsFailed: overdue.length - closed,
    message: `closed ${closed}/${overdue.length} overdue applications`,
  };
}

runAsPipeline('enforce-response-sla', main)
  .then(() => { client?.end(); process.exit(0); })
  .catch((err) => { console.error('[SLA] Fatal:', err); client?.end(); process.exit(1); });
