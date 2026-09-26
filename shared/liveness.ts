/**
 * When may a job carry the "Live · checked" badge?
 *
 * Scrapers re-read every employer board every ~4h, and ingestion refreshes
 * last_liveness_check at most every 20h (job-ingestion.service.ts), so a job
 * that is still up has a check at most ~24h old. The badge used to allow 14
 * days — "checked 5d ago" really meant "missing from the board for 5 days",
 * and 24% of badged jobs (24,160 of 99,090, measured 2026-09-26) hadn't been
 * seen in over 48h. 36h tolerates one missed scrape cycle, no more.
 */
export const LIVE_BADGE_MAX_AGE_HOURS = 36;

export interface LivenessFields {
  livenessStatus?: string | null;
  trustScore?: number | null;
  lastLivenessCheck?: Date | string | null;
}

export function hoursSinceLivenessCheck(job: LivenessFields, now: number = Date.now()): number | null {
  if (!job.lastLivenessCheck) {return null;}
  const t = new Date(job.lastLivenessCheck).getTime();
  if (!Number.isFinite(t)) {return null;}
  return Math.max(0, (now - t) / 3_600_000);
}

export function isRecentlyVerifiedLive(job: LivenessFields, now: number = Date.now()): boolean {
  if (job.livenessStatus !== 'active' || (job.trustScore ?? 0) < 90) {return false;}
  const hours = hoursSinceLivenessCheck(job, now);
  return hours !== null && hours <= LIVE_BADGE_MAX_AGE_HOURS;
}
