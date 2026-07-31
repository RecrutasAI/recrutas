/**
 * Full company job scraping pipeline:
 * 1. Scrapes all known ATS companies for fresh jobs
 * 2. Scrapes JSON-LD-approved companies' career pages
 *
 * Usage:
 *   npx tsx scripts/scrape-all-company-jobs.ts [--dry-run]
 */
import 'dotenv/config';
import postgres from 'postgres';
import { listAtsJobs } from '../server/lib/adzuna-link-resolver';
import { jobIngestionService } from '../server/services/job-ingestion.service';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service';

const DRY_RUN   = process.argv.includes('--dry-run');
const CONC      = 8;
const ATS_TYPES = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'breezy']);

async function main(): Promise<PipelineSummary> {
  const sql = postgres(process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || '', { max: 3, prepare: false });

  // Adzuna redirect-URL resolution used to run here as phase 1, re-resolving the
  // newest 500 unresolved rows every 4 hours. Removed 2026-07-31: it had no
  // consumer left. The feed deliberately serves Adzuna's native redirect URLs
  // (see project_aggregator_resolution_off), company discovery mines company
  // names and careerPageUrl rather than the resolved external_url, and the only
  // theoretical benefit — collapsing an Adzuna row against an ATS-scraped copy
  // of the same posting via external_url — measured 9 rows out of 1,586 ever
  // resolved (0.6%). Against that it spent ~3K homepage/SearXNG/careers-page/ATS
  // requests a day from the IP the ATS probe needs, and because nothing recorded
  // a failed attempt it mostly re-ground rows that had already failed.

  // --- PHASE 1: Scrape ATS companies ---
  console.log('=== PHASE 1: Scraping ATS Companies ===');
  const atsCompanies = await sql`
    SELECT "normalizedName", "detectedAts", "atsId"
    FROM discovered_companies
    WHERE status = 'approved'
      AND "detectedAts" IN ('greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'breezy')
  `;
  console.log(`Found ${atsCompanies.length} companies with ATS APIs`);

  let scraped = 0, totalJobs = 0;

  // Scraped jobs are ingested in bounded batches rather than accumulated across
  // all ~1.4K companies and flushed once at the end. Holding every job (with its
  // full description) in one array grew the heap past V8's ~650MB ceiling under
  // the cron's MemoryMax=1300M cgroup and killed the run at company ~1400/1431
  // with "Reached heap limit" (exit 134). ingestExternalJobs is stateless per
  // call — it re-checks capacity and dedups against the DB — so batching is safe,
  // and earlier batches are already visible to later batches' dedup queries.
  const FLUSH_AT = 5000;
  const pending: any[] = [];
  const ingestTotals = { inserted: 0, duplicates: 0, errors: 0, skippedNonUS: 0, skippedBadUrl: 0 };
  let ingestedAny = false;

  const flush = async (force = false) => {
    if (pending.length === 0) return;
    if (!force && pending.length < FLUSH_AT) return;
    const batch = pending.splice(0, pending.length);
    if (DRY_RUN) return;
    const s = await jobIngestionService.ingestExternalJobs(batch);
    ingestedAny = true;
    for (const k of Object.keys(ingestTotals) as Array<keyof typeof ingestTotals>) {
      ingestTotals[k] += s[k] ?? 0;
    }
  };

  for (let i = 0; i < atsCompanies.length; i += CONC) {
    const slice = atsCompanies.slice(i, i + CONC);
    const results = await Promise.allSettled(
      slice.map(async (entry) => {
        try {
          const jobs = await listAtsJobs(entry.detectedAts as any, entry.atsId);
          return jobs.length > 0 ? { company: entry.normalizedName, atsType: entry.detectedAts, jobs } : null;
        } catch { return null; }
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        scraped++;
        totalJobs += r.value.jobs.length;
        for (const j of r.value.jobs) {
          pending.push({
            title: j.title,
            company: r.value.company,
            location: j.location || '',
            description: j.description || '',
            requirements: [],
            skills: [],
            workType: 'hybrid',
            source: `ATS:${r.value.atsType}`,
            externalId: j.url,
            externalUrl: j.url,
            postedDate: new Date().toISOString(),
          });
        }
      }
    }

    await flush();

    process.stdout.write(`\r  [${Math.min(i + CONC, atsCompanies.length)}/${atsCompanies.length}] companies=${scraped} jobs=${totalJobs}   `);
  }

  console.log(`\nPhase 1: ${scraped} companies, ${totalJobs} fresh jobs`);

  // --- PHASE 2: Scrape JSON-LD-approved companies ---
  // Companies without a public ATS API but with schema.org JobPosting on /careers.
  console.log('\n=== PHASE 2: Scraping JSON-LD Companies ===');
  const jsonLdCompanies = await sql<Array<{ normalizedName: string; careerPageUrl: string | null; name: string }>>`
    SELECT "normalizedName", "careerPageUrl", name
    FROM discovered_companies
    WHERE status = 'approved'
      AND "detectedAts" = 'json_ld'
      AND "careerPageUrl" IS NOT NULL
  `;
  console.log(`Found ${jsonLdCompanies.length} JSON-LD companies`);

  let jsonLdScraped = 0, jsonLdJobs = 0;
  for (let i = 0; i < jsonLdCompanies.length; i += CONC) {
    const slice = jsonLdCompanies.slice(i, i + CONC);
    const results = await Promise.allSettled(
      slice.map(async (entry) => {
        const jobs = await fetchJsonLdJobs(entry.careerPageUrl!, entry.name);
        return jobs.length > 0 ? jobs : null;
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        jsonLdScraped++;
        jsonLdJobs += r.value.length;
        pending.push(...r.value);
      }
    }
    await flush();
    process.stdout.write(`\r  [${Math.min(i + CONC, jsonLdCompanies.length)}/${jsonLdCompanies.length}] companies=${jsonLdScraped} jobs=${jsonLdJobs}   `);
  }
  console.log(`\nPhase 2: ${jsonLdScraped} companies, ${jsonLdJobs} fresh jobs`);

  if (pending.length > 0) console.log(`\nIngesting final batch (${pending.length})...`);
  await flush(true);
  const ingestStats = ingestedAny ? ingestTotals : null;
  if (ingestStats) console.log('Stats:', ingestStats);

  const freshJobs = totalJobs + jsonLdJobs;
  console.log('\n=== DONE ===');
  console.log(`ATS companies scraped: ${scraped}`);
  console.log(`JSON-LD companies scraped: ${jsonLdScraped}`);
  console.log(`Fresh jobs found: ${freshJobs}`);

  await sql.end();

  return {
    status: (ingestStats?.errors || 0) > 0 ? 'warning' : 'ok',
    itemsProcessed: ingestStats?.inserted ?? 0,
    itemsFailed: ingestStats?.errors ?? 0,
    message: `${scraped + jsonLdScraped} companies, ${freshJobs} fresh jobs, ${ingestStats?.inserted ?? 0} inserted${DRY_RUN ? ' (dry-run)' : ''}`,
    stats: { atsCompanies: scraped, jsonLdCompanies: jsonLdScraped, freshJobs, inserted: ingestStats?.inserted ?? 0, duplicates: ingestStats?.duplicates ?? 0, errors: ingestStats?.errors ?? 0, dryRun: DRY_RUN },
  };
}

async function fetchJsonLdJobs(url: string, companyName: string): Promise<any[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0', 'Accept': 'text/html' },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return [];
    const html = await res.text();

    const postings: any[] = [];
    const blockRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    for (const match of html.matchAll(blockRe)) {
      try {
        const data = JSON.parse(match[1].trim());
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const t = item?.['@type'];
          if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
            postings.push(item);
          }
        }
      } catch { /* malformed JSON-LD — skip */ }
    }

    return postings.slice(0, 20).map((p) => {
      const rawUrl: string = p.url || p.sameAs || url;
      let externalUrl = rawUrl;
      try { externalUrl = new URL(rawUrl, url).href; } catch { /* keep raw */ }
      const loc = Array.isArray(p.jobLocation) ? p.jobLocation[0] : p.jobLocation;
      const locName: string = loc?.address?.addressLocality || loc?.name || 'Various';
      return {
        title: p.title || 'Unknown Position',
        company: companyName,
        location: locName,
        description: '',
        requirements: [],
        skills: [],
        workType: /remote|anywhere/i.test(JSON.stringify(loc ?? '')) ? 'remote' : 'hybrid',
        source: 'career_page',
        externalId: externalUrl,
        externalUrl,
        postedDate: p.datePosted || new Date().toISOString(),
      };
    });
  } catch {
    return [];
  }
}

runAsPipeline('scrape-ats', main)
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });