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
const PROBE_TIMEOUT_MS = 8000; // HEAD requests
const JSON_PROBE_TIMEOUT_MS = 10000; // JSON API requests (Lever/Ashby can be slow)
const CIRCUIT_BREAKER_THRESHOLD = 10;
const CIRCUIT_BREAKER_PAUSE_MS = 60_000;
const REDIS_429_KEY = 'ats-probe:consecutive-429s';
const REDIS_CIRCUIT_KEY = 'ats-probe:circuit-pause-until';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AtsType = 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'recruitee' | 'smartrecruiters' | 'breezy' | 'json_ld';

export interface ProbeResult {
  normalizedName: string;
  atsType: AtsType | null;
  atsId: string | null;
  careerPageUrl: string | null;
}

// ── Circuit breaker ───────────────────────────────────────────────────────────

async function isCircuitOpen(): Promise<boolean> {
  const val = await redis.get(REDIS_CIRCUIT_KEY);
  if (!val) return false;
  return Date.now() < parseInt(val, 10);
}

async function recordSuccess(): Promise<void> {
  await redis.set(REDIS_429_KEY, '0', 120);
}

async function record429(): Promise<void> {
  const count = await redis.incrWithExpire(REDIS_429_KEY, 120);
  if (count >= CIRCUIT_BREAKER_THRESHOLD) {
    const pauseUntil = Date.now() + CIRCUIT_BREAKER_PAUSE_MS;
    await redis.set(REDIS_CIRCUIT_KEY, String(pauseUntil), 65);
    console.warn('[AtsProbe] Circuit breaker tripped — pausing for 60s');
  }
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

async function probeWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probeGreenhouse(slug: string): Promise<boolean> {
  try {
    const res = await probeWithTimeout(`https://boards.greenhouse.io/${slug}`);
    if (res.status === 429) { await record429(); return false; }
    if (res.ok) { await recordSuccess(); return true; }
    return false;
  } catch {
    return false;
  }
}

async function probeLever(slug: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_PROBE_TIMEOUT_MS);
    const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) { await record429(); return false; }
    if (res.status === 404) return false;
    if (res.ok) {
      const json = await res.json().catch(() => null);
      // Lever returns [] (200) for valid company boards (even with no postings)
      // Lever returns 404 for unknown companies
      if (Array.isArray(json)) { await recordSuccess(); return true; }
    }
    return false;
  } catch {
    return false;
  }
}

async function probeAshby(slug: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_PROBE_TIMEOUT_MS);
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) { await record429(); return false; }
    if (res.ok) {
      const json = await res.json().catch(() => null);
      // Ashby returns { jobs: [...], apiVersion: "..." } for valid boards
      if (json && typeof json === 'object' && 'jobs' in json) {
        await recordSuccess();
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function probeWorkable(slug: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_PROBE_TIMEOUT_MS);
    const res = await fetch(`https://apply.workable.com/api/v1/widget/accounts/${slug}`, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) { await record429(); return false; }
    if (res.status === 404) return false;
    if (res.ok) {
      const json = await res.json().catch(() => null);
      // Workable returns { name, subdomain, ... } for valid accounts
      if (json && typeof json === 'object' && 'name' in json) {
        await recordSuccess();
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function probeRecruitee(slug: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_PROBE_TIMEOUT_MS);
    const res = await fetch(`https://${slug}.recruitee.com/api/offers`, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) { await record429(); return false; }
    if (res.status === 404) return false;
    if (res.ok) {
      const json = await res.json().catch(() => null);
      // Recruitee returns { offers: [...] } for valid accounts
      if (json && typeof json === 'object' && 'offers' in json) {
        await recordSuccess();
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function probeSmartRecruiters(slug: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_PROBE_TIMEOUT_MS);
    const res = await fetch(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) { await record429(); return false; }
    if (res.ok) {
      const json = await res.json().catch(() => null) as { content?: unknown[] } | null;
      // SmartRecruiters returns 200 { content: [] } even for unknown slugs, so a
      // valid board requires at least one live posting (identifiers are case-insensitive).
      if (json && Array.isArray(json.content) && json.content.length > 0) {
        await recordSuccess();
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function probeBreezy(slug: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_PROBE_TIMEOUT_MS);
    const res = await fetch(`https://${slug}.breezy.hr/json`, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' },
      signal: controller.signal,
      redirect: 'manual', // unknown slugs 302 → breezy.hr; don't follow into HTML
    });
    clearTimeout(timer);
    if (res.status === 429) { await record429(); return false; }
    if (res.ok) {
      const json = await res.json().catch(() => null);
      // Valid boards return a JSON array of postings.
      if (Array.isArray(json) && json.length > 0) {
        await recordSuccess();
        return true;
      }
    }
    return false;
  } catch {
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

export async function probeCompany(normalizedName: string): Promise<ProbeResult> {
  if (await isCircuitOpen()) {
    console.warn('[AtsProbe] Circuit open — skipping probe for', normalizedName);
    return { normalizedName, atsType: null, atsId: null, careerPageUrl: null };
  }

  await acquireSlot();
  try {
    const slugs = generateSlugs(normalizedName);

    for (const slug of slugs) {
      if (await probeGreenhouse(slug)) {
        return {
          normalizedName,
          atsType: 'greenhouse',
          atsId: slug,
          careerPageUrl: `https://boards.greenhouse.io/${slug}`,
        };
      }
      if (await probeLever(slug)) {
        return {
          normalizedName,
          atsType: 'lever',
          atsId: slug,
          careerPageUrl: `https://jobs.lever.co/${slug}`,
        };
      }
      if (await probeAshby(slug)) {
        return {
          normalizedName,
          atsType: 'ashby',
          atsId: slug,
          careerPageUrl: `https://jobs.ashbyhq.com/${slug}`,
        };
      }
      if (await probeWorkable(slug)) {
        return {
          normalizedName,
          atsType: 'workable',
          atsId: slug,
          careerPageUrl: `https://apply.workable.com/${slug}`,
        };
      }
      if (await probeRecruitee(slug)) {
        return {
          normalizedName,
          atsType: 'recruitee',
          atsId: slug,
          careerPageUrl: `https://${slug}.recruitee.com`,
        };
      }
      if (await probeSmartRecruiters(slug)) {
        return {
          normalizedName,
          atsType: 'smartrecruiters',
          atsId: slug,
          careerPageUrl: `https://jobs.smartrecruiters.com/${slug}`,
        };
      }
      if (await probeBreezy(slug)) {
        return {
          normalizedName,
          atsType: 'breezy',
          atsId: slug,
          careerPageUrl: `https://${slug}.breezy.hr`,
        };
      }
    }

    const jsonLd = await probeJsonLd(normalizedName);
    if (jsonLd) return jsonLd;

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
  const pending = await db
    .select({ id: discoveredCompanies.id, normalizedName: discoveredCompanies.normalizedName })
    .from(discoveredCompanies)
    .where(
      eq(discoveredCompanies.status, 'pending')
    )
    .orderBy(sql`CASE
      WHEN ${discoveredCompanies.discoverySource} = 'seed' THEN 0
      WHEN ${discoveredCompanies.discoverySource} LIKE 'apollo:%' THEN 1
      WHEN ${discoveredCompanies.discoverySource} = 'job_mining' THEN 2
      ELSE 3
    END, ${discoveredCompanies.id}`)
    .limit(limit);

  if (pending.length === 0) {
    console.log('[AtsProbe] No pending companies to probe');
    return [];
  }

  console.log(`[AtsProbe] Probing ${pending.length} companies...`);
  const results: ProbeResult[] = [];

  // Process in batches of MAX_CONCURRENT
  for (let i = 0; i < pending.length; i += MAX_CONCURRENT) {
    if (await isCircuitOpen()) {
      console.warn('[AtsProbe] Circuit open — stopping batch early');
      break;
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
