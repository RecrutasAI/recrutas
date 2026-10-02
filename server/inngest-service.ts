/**
 * Inngest client + background function definitions.
 *
 * Set INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY in Vercel env vars to enable.
 * Without these, events are no-ops (graceful degradation).
 *
 * Functions:
 * - match/recompute    — recompute matches after a new job is posted
 * - sla/enforce        — enforce 24h response SLA (replaces GitHub Actions cron fallback)
 * - candidate/notify   — send exam result notifications asynchronously
 */

import { Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'recrutas',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

// ── Event types ───────────────────────────────────────────────────────────────

export type InngestEvents = {
  'match/recompute': { data: { jobId: number; talentOwnerId: string } };
  'sla/enforce': { data: Record<string, never> };
  'candidate/notify': {
    data: {
      candidateId: string;
      type: string;
      title: string;
      message: string;
      relatedApplicationId?: number;
    };
  };
  'candidate/profile-updated': { data: { candidateId: string } };
};

// ── Recompute matches after new job posted ────────────────────────────────────

export const recomputeMatchesFunction = inngest.createFunction(
  { id: 'recompute-matches', name: 'Recompute Job Matches' },
  { event: 'match/recompute' },
  async ({ event, step }) => {
    const { jobId } = event.data;

    await step.run('recompute', async () => {
      const { storage } = await import('./storage.js');
      const { updateJobEmbedding } = await import('./services/batch-embedding.service.js');

      // Refresh embedding for the new job
      await updateJobEmbedding(jobId);

      // Clear Redis match cache for all candidates (they'll recompute on next request)
      const { redis } = await import('./lib/redis.js');
      // We use a scan-based clear in Redis, or just let TTL expire (5 min)
      // For now: store a "cache_invalidated_at" marker so clients know to refresh
      await redis.set('match:cache_invalidated_at', Date.now().toString(), 3600);

      console.log(`[Inngest] Recomputed embedding for job ${jobId}`);
    });
  }
);

// ── SLA enforcement ───────────────────────────────────────────────────────────

export const enforceSLAFunction = inngest.createFunction(
  { id: 'enforce-sla', name: 'Enforce 24h Response SLA' },
  { cron: '0 * * * *' }, // Hourly — same as GitHub Actions cron, but serverless-native
  async ({ step }) => {
    // Step 1: close overdue applications
    await step.run('enforce', async () => {
      const { storage } = await import('./storage.js');
      const { notificationService } = await import('./notification-service.js');

      const overdue = await storage.getOverdueExamApplications();
      let closed = 0;

      for (const { applicationId, candidateId, jobTitle, company } of overdue) {
        try {
          await storage.updateApplicationStatusByCandidate(applicationId, 'rejected');
          await notificationService.createNotification({
            userId: candidateId,
            type: 'application_rejected',
            title: 'Application Closed: No Response',
            message: `${company} did not respond to your ${jobTitle} application within 24 hours.`,
            priority: 'high',
            relatedApplicationId: applicationId,
            data: { jobTitle, company, reason: 'sla_expired' },
          });
          closed++;
        } catch (err) {
          console.error(`[Inngest SLA] Failed for application ${applicationId}:`, (err as Error).message);
        }
      }

      console.log(`[Inngest SLA] Closed ${closed}/${overdue.length} overdue applications`);
      return { closed, total: overdue.length };
    });

    // Step 2: warn employers who are ~12h away from the deadline
    await step.run('warn', async () => {
      const { storage } = await import('./storage.js');
      const { sendEmail, employerSLAWarningEmail } = await import('./lib/email.js');

      const nearDeadline = await storage.getApplicationsNearSLADeadline(12);
      let warned = 0;

      for (const { talentOwnerId, candidateId, jobTitle, company, hoursLeft } of nearDeadline) {
        try {
          const [employer, candidate] = await Promise.all([
            storage.getUser(talentOwnerId),
            storage.getUser(candidateId),
          ]);
          if (!employer?.email) continue;
          const candidateName = (candidate as any)?.firstName
            ? `${(candidate as any).firstName} ${(candidate as any).lastName || ''}`.trim()
            : 'A candidate';
          await sendEmail({
            to: employer.email,
            subject: `⏰ ${hoursLeft}h left to respond to ${candidateName} for ${jobTitle}`,
            html: employerSLAWarningEmail(
              (employer as any).firstName,
              candidateName,
              jobTitle,
              hoursLeft,
            ),
          });
          warned++;
        } catch (err) {
          console.error(`[Inngest SLA warn] Failed:`, (err as Error).message);
        }
      }

      console.log(`[Inngest SLA] Sent ${warned} SLA warning emails`);
      return { warned };
    });
  }
);

// ── Async candidate notification ──────────────────────────────────────────────

export const candidateNotifyFunction = inngest.createFunction(
  { id: 'candidate-notify', name: 'Candidate Notification' },
  { event: 'candidate/notify' },
  async ({ event, step }) => {
    await step.run('notify', async () => {
      const { notificationService } = await import('./notification-service.js');
      const { candidateId, type, title, message, relatedApplicationId } = event.data;

      await notificationService.createNotification({
        userId: candidateId,
        type,
        title,
        message,
        priority: 'high',
        relatedApplicationId,
      });
    });
  }
);

// ── Warm matches after profile update ────────────────────────────────────────

export const profileUpdatedFunction = inngest.createFunction(
  { id: 'profile-updated-warm-matches', name: 'Warm Matches After Profile Update' },
  { event: 'candidate/profile-updated' },
  async ({ event, step }) => {
    const { candidateId } = event.data;

    // Step 1: warm the match cache and return top matches
    const matchResult = await step.run('warm-matches', async () => {
      const { storage } = await import('./storage.js');
      const result = await storage.getJobRecommendations(candidateId);
      console.log(`[Inngest] Warmed match cache for candidate ${candidateId}`);

      // Top 5 matches already have full job data
      const top5 = (result.jobs ?? []).slice(0, 5);
      const jobDetails = top5.map((m: any) => {
          if (!m.id) return null;
          return {
            jobId: m.id,
            title: m.title,
            company: m.company,
            location: m.location ?? null,
            workType: m.workType ?? null,
            salaryMin: m.salaryMin ?? null,
            salaryMax: m.salaryMax ?? null,
            matchScore: m.matchScore ?? 0,
            skillMatches: m.skillMatches ?? [],
          };
      }).filter(Boolean);

      return {
        count: result.total ?? 0,
        jobs: jobDetails,
      };
    });

    // Step 2: send "matches ready" email
    await step.run('send-matches-email', async () => {
      const { storage } = await import('./storage.js');
      const { sendEmail, matchesReadyEmail } = await import('./lib/email.js');

      const user = await storage.getUser(candidateId);
      if (!user?.email) {
        console.warn(`[Inngest] No email for candidate ${candidateId} — skipping email`);
        return;
      }

      // Respect email notification preferences
      const prefs = await storage.getNotificationPreferences(candidateId);
      if (prefs && prefs.emailNotifications === false) {
        console.log(`[Inngest] Email notifications disabled for ${candidateId}`);
        return;
      }

      const { count, jobs } = matchResult;
      await sendEmail({
        to: user.email,
        subject: `Your ${count} job match${count !== 1 ? 'es' : ''} are ready on Recrutas`,
        html: matchesReadyEmail((user as any).first_name ?? '', count, jobs as any),
      });
      console.log(`[Inngest] Sent matches-ready email to ${user.email} (${count} matches)`);
    });
  }
);

// ── Helper: send event safely (no-op if Inngest not configured) ──────────────

export async function sendInngestEvent<K extends keyof InngestEvents>(
  name: K,
  data: InngestEvents[K]['data']
): Promise<void> {
  if (!process.env.INNGEST_EVENT_KEY) return; // graceful no-op
  try {
    await inngest.send({ name, data } as any);
  } catch (err) {
    console.warn('[Inngest] Failed to send event:', name, (err as Error).message);
  }
}

export const inngestFunctions = [
  recomputeMatchesFunction,
  enforceSLAFunction,
  candidateNotifyFunction,
  profileUpdatedFunction,
];
