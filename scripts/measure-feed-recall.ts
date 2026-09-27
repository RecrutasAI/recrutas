// Measure how much of each candidate's true top-100 the matched feed returns.
//
// Why: the feed scores a *retrieved* subset of jobs, and a job no retrieval
// lane returns can never be shown however well it fits. Nothing measured that
// gap, and on 2026-09-27 it was 79%: across every candidate with skills, the
// feed held 21% of their true top-100 and 17% of their >=75 matches — and none
// of the jobs posted the day before. See retrieveFeedCandidates in
// server/storage.ts.
//
// Ground truth = the same matcher (same filters, same scorer, same ranking)
// with retrieval effectively unbounded: every role-title and skill-overlap
// match, plus the 3,000 nearest embeddings over the whole 90-day window. So
// any difference is attributable to retrieval alone.
//
//   npx tsx scripts/measure-feed-recall.ts                    # all candidates
//   npx tsx scripts/measure-feed-recall.ts --user=<uuid>      # one candidate
//   npx tsx scripts/measure-feed-recall.ts --posted-within=1  # "Past 24 hours"
//
// Read-only. Point DATABASE_URL at the database you want to measure (a bare run
// picks up the local .env). Exits 1 when pooled recall of >=60 matches falls
// below --min-recall (default 0.9), so it can gate a matching change.
import 'dotenv/config';
import { sql } from 'drizzle-orm/sql';
import { db } from '../server/db';
import { storage, type FeedRetrievalOptions } from '../server/storage';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const ONLY_USER = arg('user');
const POSTED_WITHIN = arg('posted-within') ? Number(arg('posted-within')) : undefined;
const MIN_RECALL = arg('min-recall') ? Number(arg('min-recall')) : 0.9;

const UNBOUNDED: FeedRetrievalOptions = {
  laneLimits: { role: 1_000_000, skill: 1_000_000, fresh: 3000 },
  freshHours: 24 * 91,
};

type FeedJob = { id: number; matchScore: number; matchTier: string; createdAt: Date };

async function feed(userId: string, retrieval?: FeedRetrievalOptions): Promise<{ jobs: FeedJob[]; ms: number }> {
  // The matcher logs heavily; keep the report readable.
  const { log, time, timeEnd } = console;
  console.log = console.time = console.timeEnd = () => {};
  const startedAt = Date.now();
  try {
    const result = await storage.getJobRecommendations(
      userId,
      POSTED_WITHIN ? { postedWithinDays: POSTED_WITHIN } : {},
      { page: 1, limit: 100 },
      retrieval,
    );
    return { jobs: result.jobs, ms: Date.now() - startedAt };
  } finally {
    Object.assign(console, { log, time, timeEnd });
  }
}

async function main() {
  const rows = ONLY_USER
    ? [{ user_id: ONLY_USER }]
    : await db.execute(sql`
        SELECT user_id FROM candidate_users
        WHERE jsonb_array_length(COALESCE(skills, '[]'::jsonb)) > 0
        ORDER BY user_id`) as unknown as { user_id: string }[];

  const pooled = { top: [0, 0], s75: [0, 0], s60: [0, 0] };
  console.log(`candidates: ${rows.length}${POSTED_WITHIN ? ` · posted within ${POSTED_WITHIN}d` : ''}`);
  console.log('candidate  recall@100   >=75     >=60     feed  truth   feed-ms');

  for (const { user_id } of rows) {
    const actual = await feed(user_id);
    const truth = await feed(user_id, UNBOUNDED);
    // Discovery fallback = no job cleared the score floor; nothing to recall.
    const truthJobs = truth.jobs.filter(j => j.matchTier !== 'discovery');
    const got = new Set(actual.jobs.map(j => j.id));
    const hits = (jobs: FeedJob[]) => [jobs.filter(j => got.has(j.id)).length, jobs.length];
    const top = hits(truthJobs);
    const s75 = hits(truthJobs.filter(j => j.matchScore >= 75));
    const s60 = hits(truthJobs.filter(j => j.matchScore >= 60));
    for (const [key, [h, n]] of Object.entries({ top, s75, s60 })) {
      pooled[key as keyof typeof pooled][0] += h;
      pooled[key as keyof typeof pooled][1] += n;
    }
    const fmt = ([h, n]: number[]) => (n ? `${h}/${n}` : '-').padEnd(9);
    console.log(`${user_id.slice(0, 8)}   ${fmt(top)}  ${fmt(s75)}${fmt(s60)}${String(actual.jobs.length).padEnd(6)}${String(truthJobs.length).padEnd(7)}${actual.ms}`);
  }

  const pct = ([h, n]: number[]) => (n ? `${((h / n) * 100).toFixed(1)}% (${h}/${n})` : 'n/a');
  console.log(`\npooled recall@100: ${pct(pooled.top)}`);
  console.log(`pooled recall of >=75 matches: ${pct(pooled.s75)}`);
  console.log(`pooled recall of >=60 matches: ${pct(pooled.s60)}`);

  const [h60, n60] = pooled.s60;
  if (n60 > 0 && h60 / n60 < MIN_RECALL) {
    console.error(`FAIL: >=60 recall ${(h60 / n60).toFixed(3)} is below --min-recall=${MIN_RECALL}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
