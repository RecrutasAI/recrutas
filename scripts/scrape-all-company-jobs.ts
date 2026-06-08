/**
 * Full company job discovery pipeline:
 * 1. Resolves all unresolved Adzuna URLs
 * 2. Extracts ATS IDs from resolved URLs
 * 3. Scrapes all known ATS companies for fresh jobs
 *
 * Usage:
 *   npx tsx scripts/scrape-all-company-jobs.ts [--dry-run] [--limit N]
 */
import 'dotenv/config';
import postgres from 'postgres';
import { listAtsJobs, resolveAdzunaLink } from '../server/lib/adzuna-link-resolver';
import { jobIngestionService } from '../server/services/job-ingestion.service';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service';

const DRY_RUN   = process.argv.includes('--dry-run');
const LIMIT_ARG  = process.argv.indexOf('--limit');
const MAX_ADZUNA = LIMIT_ARG !== -1 ? parseInt(process.argv[LIMIT_ARG + 1], 10) : 500;
const CONC      = 8;
const ATS_TYPES = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'recruitee']);

async function main(): Promise<PipelineSummary> {
  const sql = postgres(process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || '', { max: 3, prepare: false });

  // --- PHASE 1: Resolve Adzuna redirect URLs ---
  console.log('=== PHASE 1: Resolving Adzuna URLs ===');
  const unresolved = await sql`
    SELECT id, title, company, location, external_url, description
    FROM job_postings
    WHERE source = 'Adzuna' AND external_url LIKE '%adzuna%'
    ORDER BY id DESC
    LIMIT ${MAX_ADZUNA}
  `;
  console.log(`Found ${unresolved.length} unresolved Adzuna jobs`);

  let resolved = 0, stillAdzuna = 0;
  const updates: Array<{ id: number; url: string; via: string }> = [];

  for (let i = 0; i < unresolved.length; i += CONC) {
    const slice = unresolved.slice(i, i + CONC);
    const results = await Promise.allSettled(
      slice.map(async (j) => {
        const r = await resolveAdzunaLink({
          title: j.title,
          company: j.company,
          location: j.location,
          fallbackUrl: j.external_url,
          description: j.description ?? undefined,
        });
        return { id: j.id, url: r.url, via: r.resolvedVia };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.url !== r.value.url) break; // noop
        if (!r.value.url.includes('adzuna')) {
          resolved++;
          updates.push(r.value);
        } else {
          stillAdzuna++;
        }
      }
    }

    process.stdout.write(`\r  [${i + CONC}/${unresolved.length}] resolved=${resolved} still_adzuna=${stillAdzuna}   `);
  }
  console.log(`\nPhase 1: ${resolved} resolved, ${stillAdzuna} still Adzuna`);

  if (!DRY_RUN && updates.length > 0) {
    // Bulk update via unnest — one round trip instead of N
    const ids  = updates.map(u => u.id);
    const urls = updates.map(u => u.url);
    await sql`
      UPDATE job_postings AS jp
      SET external_url = v.url
      FROM unnest(${sql.array(ids)}::int[], ${sql.array(urls)}::text[]) AS v(id, url)
      WHERE jp.id = v.id
    `;
  }

  // --- PHASE 2: Scrape ATS companies ---
  console.log('\n=== PHASE 2: Scraping ATS Companies ===');
  const atsCompanies = await sql`
    SELECT "normalizedName", "detectedAts", "atsId"
    FROM discovered_companies
    WHERE status = 'approved'
      AND "detectedAts" IN ('greenhouse', 'lever', 'ashby', 'workable', 'recruitee')
  `;
  console.log(`Found ${atsCompanies.length} companies with ATS APIs`);

  let scraped = 0, totalJobs = 0;
  const allJobs: any[] = [];

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
          allJobs.push({
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

    process.stdout.write(`\r  [${Math.min(i + CONC, atsCompanies.length)}/${atsCompanies.length}] companies=${scraped} jobs=${totalJobs}   `);
  }

  console.log(`\nPhase 2: ${scraped} companies, ${totalJobs} fresh jobs`);

  // --- PHASE 3: Scrape JSON-LD-approved companies ---
  // Companies without a public ATS API but with schema.org JobPosting on /careers.
  console.log('\n=== PHASE 3: Scraping JSON-LD Companies ===');
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
        allJobs.push(...r.value);
      }
    }
    process.stdout.write(`\r  [${Math.min(i + CONC, jsonLdCompanies.length)}/${jsonLdCompanies.length}] companies=${jsonLdScraped} jobs=${jsonLdJobs}   `);
  }
  console.log(`\nPhase 3: ${jsonLdScraped} companies, ${jsonLdJobs} fresh jobs`);

  let ingestStats: any = null;
  if (!DRY_RUN && allJobs.length > 0) {
    console.log('\nIngesting...');
    ingestStats = await jobIngestionService.ingestExternalJobs(allJobs);
    console.log('Stats:', ingestStats);
  }

  const freshJobs = totalJobs + jsonLdJobs;
  console.log('\n=== DONE ===');
  console.log(`Adzuna URLs resolved: ${resolved}`);
  console.log(`ATS companies scraped: ${scraped}`);
  console.log(`JSON-LD companies scraped: ${jsonLdScraped}`);
  console.log(`Fresh jobs found: ${freshJobs}`);

  await sql.end();

  return {
    status: (ingestStats?.errors || 0) > 0 ? 'warning' : 'ok',
    itemsProcessed: ingestStats?.inserted ?? 0,
    itemsFailed: ingestStats?.errors ?? 0,
    message: `${resolved} URLs resolved, ${scraped + jsonLdScraped} companies, ${freshJobs} fresh jobs, ${ingestStats?.inserted ?? 0} inserted${DRY_RUN ? ' (dry-run)' : ''}`,
    stats: { resolved, atsCompanies: scraped, jsonLdCompanies: jsonLdScraped, freshJobs, inserted: ingestStats?.inserted ?? 0, duplicates: ingestStats?.duplicates ?? 0, errors: ingestStats?.errors ?? 0, dryRun: DRY_RUN },
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