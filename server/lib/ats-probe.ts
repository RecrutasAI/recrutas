/**
 * ATS Probe Service
 *
 * Probes company slugs against Greenhouse, Lever, Ashby, Workable, and Recruitee public APIs
 * to detect which ATS a company uses. Designed for serverless: concurrency
 * is bounded per-invocation, circuit breaker state is persisted in Redis
 * so it survives across Vercel function cold starts.
 *
 * Throttling:
 *  - MAX_CONCURRENT = 10 simultaneous probes
 *  - BATCH_DELAY_MS = 200ms between batches
 *  - Circuit breaker: 10 consecutive 429s → 60s pause (Redis-backed)
 */

import { db } from '../db.js';
import { discoveredCompanies } from '../../shared/schema.js';
import { eq, or } from 'drizzle-orm';
import { sql } from 'drizzle-orm/sql';
import { redis } from './redis.js';
import { resolveHomepage, analyzeCareersPage } from './adzuna-link-resolver.js';

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_CONCURRENT = 10;
const BATCH_DELAY_MS = 200;
const JSON_PROBE_TIMEOUT_MS = 10000; // JSON API requests (Lever/Ashby can be slow)
const CIRCUIT_BREAKER_THRESHOLD = 10;
const CIRCUIT_BREAKER_PAUSE_MS = 60_000;
const REDIS_429_KEY = 'ats-probe:consecutive-429s';
const REDIS_CIRCUIT_KEY = 'ats-probe:circuit-pause-until';

const ALL_PROVIDERS = [
  'greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'breezy',
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export type AtsType = 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'recruitee' | 'smartrecruiters' | 'breezy' | 'json_ld';

export interface ProbeResult {
  normalizedName: string;
  atsType: AtsType | null;
  atsId: string | null;
  careerPageUrl: string | null;
  /**
   * True when the probe could not reach a verdict (rate limited / provider
   * circuit open). Callers MUST leave these companies `pending` for a later
   * run — treating them as "no ATS" permanently rejects companies we never
   * actually checked.
   */
  inconclusive?: boolean;
}

/** Thrown when a provider rate-limits us, so a 429 is never mistaken for "no ATS". */
class RateLimitedError extends Error {
  constructor(public provider: string) {
    super(`rate limited by ${provider}`);
    this.name = 'RateLimitedError';
  }
}

// ── Circuit breaker (per provider) ────────────────────────────────────────────
//
// The breaker is keyed per provider: Greenhouse rate-limiting us must not stop
// us probing Lever/Ashby/etc. A tripped provider is skipped for its pause
// window while every other provider keeps working.

async function isCircuitOpen(provider: string): Promise<boolean> {
  const val = await redis.get(`${REDIS_CIRCUIT_KEY}:${provider}`);
  if (!val) return false;
  return Date.now() < parseInt(val, 10);
}

/**
 * Ms until the *first* provider comes back, but only when every provider is
 * currently paused. If even one is usable we return 0 and keep probing — a
 * single hot provider must never stall the whole run.
 */
async function allProvidersPausedForMs(): Promise<number> {
  const remaining = await Promise.all(
    ALL_PROVIDERS.map(async p => {
      const val = await redis.get(`${REDIS_CIRCUIT_KEY}:${p}`);
      const ms = val ? parseInt(val, 10) - Date.now() : 0;
      return ms > 0 ? ms : 0;
    })
  );
  if (remaining.some(ms => ms === 0)) return 0; // at least one provider is live
  return Math.min(...remaining);
}

async function recordSuccess(provider: string): Promise<void> {
  await redis.set(`${REDIS_429_KEY}:${provider}`, '0', 120);
}

async function record429(provider: string): Promise<void> {
  const count = await redis.incrWithExpire(`${REDIS_429_KEY}:${provider}`, 120);
  if (count >= CIRCUIT_BREAKER_THRESHOLD) {
    const pauseUntil = Date.now() + CIRCUIT_BREAKER_PAUSE_MS;
    await redis.set(`${REDIS_CIRCUIT_KEY}:${provider}`, String(pauseUntil), 65);
    console.warn(`[AtsProbe] Circuit breaker tripped for ${provider} — pausing it for 60s`);
    noteProviderTrip(provider);
  }
}

// ── Persistently blocked providers ────────────────────────────────────────────
//
// A provider that trips its breaker over and over inside one run isn't having a
// blip — it is refusing us outright. Measured on the cron box: Workable returns
// 429 even for sequential requests 2s apart against known-good slugs, so it is
// blocked at the account/IP level and no amount of pacing recovers it.
//
// Requiring coverage from such a provider is corrosive: every company comes back
// `inconclusive` and stays pending forever, so genuine no-ATS companies never
// drain and the backlog stops moving. Once a provider is judged degraded we stop
// counting it toward coverage, and a company can reach a verdict on the rest.
//
// This is deliberately scoped to the low-yield failure case: Workable and
// Recruitee together account for ~99 of ~4,400 jobs ingested per week, the two
// smallest of seven providers. Anything we misjudge is recoverable by re-probing
// the rejected pool (scripts/reprobe-rejected-companies.ts).

const DEGRADED_TRIP_THRESHOLD = 3;

const runTripCounts = new Map<string, number>();
const degradedProviders = new Set<string>();

function resetRunProviderHealth(): void {
  runTripCounts.clear();
  degradedProviders.clear();
}

function noteProviderTrip(provider: string): void {
  const trips = (runTripCounts.get(provider) ?? 0) + 1;
  runTripCounts.set(provider, trips);
  if (trips >= DEGRADED_TRIP_THRESHOLD && !degradedProviders.has(provider)) {
    degradedProviders.add(provider);
    console.warn(
      `[AtsProbe] ${provider} tripped ${trips}x this run — treating it as blocked ` +
      `and no longer requiring its coverage to reach a verdict`
    );
  }
}

/** Guard every provider call: skip fast if that provider is paused. */
async function guardProvider(provider: string): Promise<void> {
  if (await isCircuitOpen(provider)) throw new RateLimitedError(provider);
}

// ── Concurrency semaphore ─────────────────────────────────────────────────────

let activeProbes = 0;

async function acquireSlot(): Promise<void> {
  while (activeProbes >= MAX_CONCURRENT) {
    await delay(50);
  }
  activeProbes++;
}

function releaseSlot(): void {
  activeProbes--;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Individual ATS probes ─────────────────────────────────────────────────────

async function probeGreenhouse(slug: string): Promise<boolean> {
  try {
    await guardProvider('greenhouse');
    // Must use the API host, not boards.greenhouse.io. The HTML host now 301s
    // for EVERY slug (verified against known-good boards and a nonsense slug
    // alike), and following that redirect lands on bot protection — measured
    // 403/406 on every single request and not one 200, so this probe could
    // never return a positive. Greenhouse is our highest-yield source, so this
    // silently starved company discovery of its biggest contributor.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_PROBE_TIMEOUT_MS);
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) { await record429('greenhouse'); throw new RateLimitedError('greenhouse'); }
    if (res.status === 404) return false; // unknown board
    if (res.ok) {
      const json = await res.json().catch(() => null);
      // Valid boards return { jobs: [...], meta: {...} } — including {"jobs":[]}
      // for a real board with no live postings, which is still a real board.
      if (json && typeof json === 'object' && Array.isArray((json as { jobs?: unknown }).jobs)) {
        await recordSuccess('greenhouse');
        return true;
      }
    }
    return false;
  } catch (e) {
    if (e instanceof RateLimitedError) throw e;
    return false;
  }
}

async function probeLever(slug: string): Promise<boolean> {
  try {
    await guardProvider('lever');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_PROBE_TIMEOUT_MS);
    const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) { await record429('lever'); throw new RateLimitedError('lever'); }
    if (res.status === 404) return false;
    if (res.ok) {
      const json = await res.json().catch(() => null);
      // Lever returns [] (200) for valid company boards (even with no postings)
      // Lever returns 404 for unknown companies
      if (Array.isArray(json)) { await recordSuccess('lever'); return true; }
    }
    return false;
  } catch (e) {
    if (e instanceof RateLimitedError) throw e;
    return false;
  }
}

async function probeAshby(slug: string): Promise<boolean> {
  try {
    await guardProvider('ashby');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_PROBE_TIMEOUT_MS);
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) { await record429('ashby'); throw new RateLimitedError('ashby'); }
    if (res.ok) {
      const json = await res.json().catch(() => null);
      // Ashby returns { jobs: [...], apiVersion: "..." } for valid boards
      if (json && typeof json === 'object' && 'jobs' in json) {
        await recordSuccess('ashby');
        return true;
      }
    }
    return false;
  } catch (e) {
    if (e instanceof RateLimitedError) throw e;
    return false;
  }
}

async function probeWorkable(slug: string): Promise<boolean> {
  try {
    await guardProvider('workable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_PROBE_TIMEOUT_MS);
    const res = await fetch(`https://apply.workable.com/api/v1/widget/accounts/${slug}`, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) { await record429('workable'); throw new RateLimitedError('workable'); }
    if (res.status === 404) return false;
    if (res.ok) {
      const json = await res.json().catch(() => null);
      // Workable returns { name, subdomain, ... } for valid accounts
      if (json && typeof json === 'object' && 'name' in json) {
        await recordSuccess('workable');
        return true;
      }
    }
    return false;
  } catch (e) {
    if (e instanceof RateLimitedError) throw e;
    return false;
  }
}

async function probeRecruitee(slug: string): Promise<boolean> {
  try {
    await guardProvider('recruitee');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_PROBE_TIMEOUT_MS);
    const res = await fetch(`https://${slug}.recruitee.com/api/offers`, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) { await record429('recruitee'); throw new RateLimitedError('recruitee'); }
    if (res.status === 404) return false;
    if (res.ok) {
      const json = await res.json().catch(() => null);
      // Recruitee returns { offers: [...] } for valid accounts
      if (json && typeof json === 'object' && 'offers' in json) {
        await recordSuccess('recruitee');
        return true;
      }
    }
    return false;
  } catch (e) {
    if (e instanceof RateLimitedError) throw e;
    return false;
  }
}

async function probeSmartRecruiters(slug: string): Promise<boolean> {
  try {
    await guardProvider('smartrecruiters');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_PROBE_TIMEOUT_MS);
    const res = await fetch(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) { await record429('smartrecruiters'); throw new RateLimitedError('smartrecruiters'); }
    if (res.ok) {
      const json = await res.json().catch(() => null) as { content?: unknown[] } | null;
      // SmartRecruiters returns 200 { content: [] } even for unknown slugs, so a
      // valid board requires at least one live posting (identifiers are case-insensitive).
      if (json && Array.isArray(json.content) && json.content.length > 0) {
        await recordSuccess('smartrecruiters');
        return true;
      }
    }
    return false;
  } catch (e) {
    if (e instanceof RateLimitedError) throw e;
    return false;
  }
}

async function probeBreezy(slug: string): Promise<boolean> {
  try {
    await guardProvider('breezy');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_PROBE_TIMEOUT_MS);
    const res = await fetch(`https://${slug}.breezy.hr/json`, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
      redirect: 'manual', // unknown slugs 302 → breezy.hr; don't follow into HTML
    });
    clearTimeout(timer);
    if (res.status === 429) { await record429('breezy'); throw new RateLimitedError('breezy'); }
    if (res.ok) {
      const json = await res.json().catch(() => null);
      // Valid boards return a JSON array of postings.
      if (Array.isArray(json) && json.length > 0) {
        await recordSuccess('breezy');
        return true;
      }
    }
    return false;
  } catch (e) {
    if (e instanceof RateLimitedError) throw e;
    return false;
  }
}

// ── JSON-LD / embed probe (fallback when slug probes miss) ───────────────────
//
// Resolves the company homepage (Clearbit + domain-guess), fetches /careers,
// and looks for either an embedded ATS slug (greenhouse/lever/etc.) or
// schema.org JobPosting JSON-LD. Either signal proves the company has a
// scrapeable careers page even if its name doesn't slug into a known ATS.
//
// Gated by PROBE_JSON_LD=1 because each call can do a Clearbit lookup plus
// up to ~50 candidate-domain HEAD requests; we don't want it firing for
// every miss until we've watched it under load.
async function probeJsonLd(name: string): Promise<ProbeResult | null> {
  if (process.env.PROBE_JSON_LD !== '1') return null;
  try {
    const homepage = await resolveHomepage(name);
    if (!homepage) return null;
    const analysis = await analyzeCareersPage(homepage);
    if (!analysis) return null;

    if (analysis.embed) {
      return {
        normalizedName: name,
        atsType: analysis.embed.atsType as AtsType,
        atsId: analysis.embed.atsId,
        careerPageUrl: atsCareerUrl(analysis.embed.atsType as AtsType, analysis.embed.atsId),
      };
    }
    if (analysis.jsonLdJobs.length > 0) {
      const careersUrl = `${homepage.replace(/\/$/, '')}/careers`;
      return {
        normalizedName: name,
        atsType: 'json_ld',
        atsId: null,
        careerPageUrl: careersUrl,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function atsCareerUrl(atsType: AtsType, atsId: string): string {
  switch (atsType) {
    case 'greenhouse': return `https://boards.greenhouse.io/${atsId}`;
    case 'lever':      return `https://jobs.lever.co/${atsId}`;
    case 'ashby':      return `https://jobs.ashbyhq.com/${atsId}`;
    case 'workable':   return `https://apply.workable.com/${atsId}`;
    case 'recruitee':  return `https://${atsId}.recruitee.com`;
    case 'smartrecruiters': return `https://jobs.smartrecruiters.com/${atsId}`;
    case 'breezy':     return `https://${atsId}.breezy.hr`;
    default:           return '';
  }
}

// ── Slug generation ───────────────────────────────────────────────────────────

function generateSlugs(normalizedName: string): string[] {
  const base = normalizedName.toLowerCase();
  return [
    base.replace(/\s+/g, ''),       // "cockroachlabs"
    base.replace(/\s+/g, '-'),      // "cockroach-labs"
    base.replace(/\s+/g, '_'),      // "cockroach_labs"
    base.replace(/[^a-z0-9]/g, ''), // strip all non-alphanumeric
  ].filter((v, i, arr) => arr.indexOf(v) === i); // dedupe
}

// ── Single company probe ──────────────────────────────────────────────────────

const PROVIDER_PROBES: ReadonlyArray<{
  name: AtsType;
  probe: (slug: string) => Promise<boolean>;
}> = [
  { name: 'greenhouse',      probe: probeGreenhouse },
  { name: 'lever',           probe: probeLever },
  { name: 'ashby',           probe: probeAshby },
  { name: 'workable',        probe: probeWorkable },
  { name: 'recruitee',       probe: probeRecruitee },
  { name: 'smartrecruiters', probe: probeSmartRecruiters },
  { name: 'breezy',          probe: probeBreezy },
];

export async function probeCompany(normalizedName: string): Promise<ProbeResult> {
  await acquireSlot();
  try {
    const slugs = generateSlugs(normalizedName);
    // Providers we could not check this pass (paused circuit or live 429). If we
    // find nothing AND coverage was incomplete, the answer is "don't know" —
    // not "no ATS" — so the company stays pending for a later run.
    const unchecked = new Set<string>();

    for (const slug of slugs) {
      for (const { name, probe } of PROVIDER_PROBES) {
        // A provider paused by its own circuit is skipped, not fatal — the
        // other six still get their chance at this company.
        if (await isCircuitOpen(name)) { unchecked.add(name); continue; }
        try {
          if (await probe(slug)) {
            return { normalizedName, atsType: name, atsId: slug, careerPageUrl: atsCareerUrl(name, slug) };
          }
        } catch (e) {
          if (e instanceof RateLimitedError) { unchecked.add(e.provider); continue; }
          throw e;
        }
      }
    }

    const jsonLd = await probeJsonLd(normalizedName);
    if (jsonLd) return jsonLd;

    // Providers we've judged blocked for this whole run don't count as missing
    // coverage — otherwise nothing ever reaches a verdict while they're down.
    const blocking = [...unchecked].filter(p => !degradedProviders.has(p));
    if (blocking.length > 0) {
      console.warn(`[AtsProbe] ${normalizedName}: inconclusive (unchecked: ${blocking.join(', ')})`);
      return { normalizedName, atsType: null, atsId: null, careerPageUrl: null, inconclusive: true };
    }
    return { normalizedName, atsType: null, atsId: null, careerPageUrl: null };
  } finally {
    releaseSlot();
  }
}

// ── Batch probe ───────────────────────────────────────────────────────────────

export async function probePendingCompanies(limit: number = 10): Promise<ProbeResult[]> {
  if (!db) {
    console.warn('[AtsProbe] DB not available');
    return [];
  }

  // Fetch pending companies with no ATS detected yet.
  // Prioritize higher-yield sources: manual seeds > Apollo channels > job_mining.
  // This keeps the 361+ queued Apollo seeds from getting buried behind the
  // ~14% structural-yield job_mining backlog (see project_aggregator_to_ats_funnel).
  // Ordering, in priority order:
  //   1. never probed (lastProbedAt IS NULL) — includes fresh discoveries
  //   2. least recently probed — so a company that came back inconclusive sinks
  //      to the back instead of re-sorting to the front of every nightly run
  //   3. higher-yield sources first: manual seeds > Apollo channels > job_mining
  //      (keeps queued Apollo seeds from getting buried behind the ~14%
  //      structural-yield job_mining backlog — see project_aggregator_to_ats_funnel)
  const pending = await db
    .select({ id: discoveredCompanies.id, normalizedName: discoveredCompanies.normalizedName })
    .from(discoveredCompanies)
    .where(
      eq(discoveredCompanies.status, 'pending')
    )
    //   4. tech-heavy companies first, WITHIN each source tier. Deliberately
    //      ranked *after* the source CASE, not before: Apollo seeds have no
    //      postings yet so their techScore is 0, and promoting techScore above
    //      source would re-bury them behind job_mining — undoing the fix the
    //      rule above exists for. See server/lib/tech-roles.ts.
    .orderBy(sql`
      (${discoveredCompanies.lastProbedAt} IS NOT NULL),
      ${discoveredCompanies.lastProbedAt} ASC,
      CASE
        WHEN ${discoveredCompanies.discoverySource} = 'seed' THEN 0
        WHEN ${discoveredCompanies.discoverySource} LIKE 'apollo:%' THEN 1
        WHEN ${discoveredCompanies.discoverySource} = 'job_mining' THEN 2
        ELSE 3
      END,
      ${discoveredCompanies.techScore} DESC NULLS LAST,
      ${discoveredCompanies.id}`)
    .limit(limit);

  if (pending.length === 0) {
    console.log('[AtsProbe] No pending companies to probe');
    return [];
  }

  console.log(`[AtsProbe] Probing ${pending.length} companies...`);
  resetRunProviderHealth();
  const results: ProbeResult[] = [];

  // Process in batches of MAX_CONCURRENT
  for (let i = 0; i < pending.length; i += MAX_CONCURRENT) {
    // A tripped circuit is a 60s cooldown, NOT a reason to abandon the run.
    // (This used to `break`, which threw away ~1,470 of every 1,500 companies
    // and is why the probe backlog was only draining ~30/day.)
    const waitMs = await allProvidersPausedForMs();
    if (waitMs > 0) {
      console.warn(`[AtsProbe] Every provider paused — waiting ${Math.ceil(waitMs / 1000)}s, then continuing`);
      await delay(Math.min(waitMs, CIRCUIT_BREAKER_PAUSE_MS) + 500);
    }

    const batch = pending.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.all(
      batch.map(c => probeCompany(c.normalizedName))
    );
    results.push(...batchResults);

    // Delay between batches (not needed after last batch)
    if (i + MAX_CONCURRENT < pending.length) {
      await delay(BATCH_DELAY_MS);
    }
  }

  const found = results.filter(r => r.atsType !== null).length;
  console.log(`[AtsProbe] Done: ${found}/${results.length} companies matched an ATS`);
  return results;
}
