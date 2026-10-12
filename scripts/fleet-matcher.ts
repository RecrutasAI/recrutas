/**
 * The server's two light steps in matching users to Fleet jobs. The heavy work (vectors for
 * ~875K jobs, comparing every user with every job) runs on GitHub: see the jobs-fleet "Job
 * vectors" workflow and the private recrutas-matcher repo.
 *
 *   npx tsx scripts/fleet-matcher.ts export   # resume vectors (anonymous ids) + Fleet jobs we show → inbox
 *   npx tsx scripts/fleet-matcher.ts ingest   # outbox → insert new matches (vectors attached), close closed ones
 *
 * Exchange happens through the private Hugging Face dataset MATCHER_DATASET. Ids are a keyed
 * hash (MATCHER_ID_KEY) only this server can map back; no names or emails leave it.
 * Env: HF_TOKEN, MATCHER_ID_KEY, MATCHER_DATASET (default recrutas/matcher).
 */
import 'dotenv/config';
import { createHmac } from 'crypto';
import { gunzipSync } from 'zlib';
import { sql } from 'drizzle-orm/sql';
import { db } from '../server/db';
import { jobIngestionService, backfillPostedAt, type ExternalJobInput } from '../server/services/job-ingestion.service';
import { extractSkillsFromText } from '../server/utils/skill-extractor';
import { recordPipelineRun } from '../server/services/pipeline-run.service';
import { getDirectUsJobLinks } from '../server/storage';
import { AGGREGATOR_SOURCES, THIRD_PARTY_COMPANIES } from '../server/lib/third-party';
import { linkKey } from '../server/lib/canonical-url';
import { vendorJobId } from '../server/lib/ats-job-key';

/** Employers we can't name: Oracle sites known only by a code. Shared with the matcher's catalog count. */
export const UNNAMED_EMPLOYER = /saasfaprod|oraclecloud\.com|\(CX_\d+\)/i;

const DATASET = process.env.MATCHER_DATASET || 'recrutas/matcher';
const HF = 'https://huggingface.co';
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

function need(name: string): string {
  const v = process.env[name];
  if (!v) {throw new Error(`${name} is not set`);}
  return v;
}

/**
 * How the matcher looks up a job's posting date in the Fleet: by the ATS's own job id when the
 * link carries one ("smartrecruiters:744000154370085", the same id the Fleet reads), since the two
 * catalogs can link the same posting differently; otherwise by link fingerprint.
 */
export function dateLookupKey(source: string, url: string): { kind: 'job' | 'link'; key: string } {
  const vendor = source.replace(/^ATS:/i, '').toLowerCase();
  const id = vendorJobId(source, url);
  return id ? { kind: 'job', key: `${vendor}:${id}` } : { kind: 'link', key: linkKey(url) };
}

export function pseudonym(userId: string, key: string): string {
  return createHmac('sha256', key).update(userId).digest('hex').slice(0, 32);
}

/** Commit small files to the dataset in one commit (inline, a few MB at most). */
async function upload(files: Array<{ path: string; content: string | Buffer }>, summary: string): Promise<void> {
  const body = [
    JSON.stringify({ key: 'header', value: { summary } }),
    ...files.map(f => JSON.stringify({ key: 'file', value: { path: f.path, content: Buffer.from(f.content).toString('base64'), encoding: 'base64' } })),
  ].join('\n');
  const r = await fetch(`${HF}/api/datasets/${DATASET}/commit/main`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${need('HF_TOKEN')}`, 'Content-Type': 'application/x-ndjson' },
    body,
  });
  if (!r.ok) {throw new Error(`upload: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);}
}

/**
 * Drop the dataset's version history, keeping only the current files. Old commits would otherwise
 * keep a deleted user's anonymous resume vector forever. Run once a day, from the 01:50 UTC export.
 */
async function squashHistory(): Promise<void> {
  const r = await fetch(`${HF}/api/datasets/${DATASET}/super-squash/main`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${need('HF_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Daily history squash: deleted users leave no copies' }),
  });
  if (!r.ok) {throw new Error(`squash: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);}
}

async function download(path: string): Promise<Buffer | null> {
  const r = await fetch(`${HF}/datasets/${DATASET}/resolve/main/${path}`, { headers: { Authorization: `Bearer ${need('HF_TOKEN')}` } });
  if (r.status === 404) {return null;}
  if (!r.ok) {throw new Error(`download ${path}: HTTP ${r.status}`);}
  return Buffer.from(await r.arrayBuffer());
}

async function exportInbox(): Promise<string> {
  const key = need('MATCHER_ID_KEY');
  const cands = rows(await db.execute(sql`SELECT user_id::text AS id, embedding::text AS v FROM candidate_users WHERE embedding IS NOT NULL`));
  const held = rows(await db.execute(sql`
    SELECT substring(external_id FROM 7) AS id FROM job_postings WHERE external_id LIKE 'fleet:%' AND status = 'active'`));
  const inbox = {
    exported_at: new Date().toISOString(),
    candidates: cands.map(c => ({ pid: pseudonym(c.id, key), v: JSON.parse(c.v) as number[] })),
    held: held.map(h => h.id as string),
  };
  // For the deduplicated catalog count the homepage shows: fingerprints of our own direct links
  // (Fleet link normalisation, server/lib/canonical-url.ts), our company names, and the rules the
  // matcher applies to Fleet jobs so both sides count the same way. Plain JSON text: the dataset's
  // simple upload rejects binary files.
  const links = await getDirectUsJobLinks();
  // Our live jobs with no posting date: the matcher answers with the Fleet's date for each one it
  // holds (the Fleet reads every board in full), and ingest fills them in.
  const undated = rows(await db.execute(sql`
    SELECT source, external_url FROM job_postings WHERE status = 'active' AND posted_at IS NULL AND external_url IS NOT NULL`));
  const undatedKeys = undated.map(u => dateLookupKey(u.source, u.external_url));
  const catalog = JSON.stringify({
    exported_at: inbox.exported_at,
    link_keys: [...new Set(links.map(l => linkKey(l.url)))],
    companies: [...new Set(links.map(l => l.company.trim().toLowerCase()).filter(Boolean))],
    third_party_companies: [...THIRD_PARTY_COMPANIES],
    third_party_sources: [...AGGREGATOR_SOURCES],
    unnamed_employer: UNNAMED_EMPLOYER.source,
    undated_job_keys: [...new Set(undatedKeys.filter(k => k.kind === 'job').map(k => k.key))],
    undated_link_keys: [...new Set(undatedKeys.filter(k => k.kind === 'link').map(k => k.key))],
  });
  await upload([
    { path: 'inbox/candidates.json', content: JSON.stringify(inbox) },
    { path: 'inbox/recrutas-links.json', content: catalog },
  ], `Inbox: ${inbox.candidates.length} users, ${inbox.held.length} shown Fleet jobs, ${links.length} direct links`);
  const squashed = new Date().getUTCHours() === 1;
  if (squashed) {await squashHistory();}
  return `${squashed ? 'history squashed, ' : ''}exported ${inbox.candidates.length} users, ${inbox.held.length} shown Fleet jobs, ${links.length} direct links, ${undated.length} undated jobs (${Math.round(catalog.length / 1024)} KB)`;
}

interface FleetJob {
  job_id: string; title: string | null; company_name: string | null; location: string | null; description: string | null;
  url: string | null; apply_url: string | null; ats: string | null; posted_at: string | null; is_remote: boolean | null;
  salary_min: number | null; salary_max: number | null; vector: number[];
}

/** A company name people can recognise, or null when all we have is a system code. */
export function employerName(raw: string | null): string | null {
  const name = (raw || '').replace(/^\s*(careers|jobs|openings|work|join us) at\s+/i, '').trim();
  // Oracle sites the Fleet couldn't name: "Fa Ertb Saasfaprod1", "eubt.fa.us6.oraclecloud.com", "Ebwh (CX_1001)".
  // A job is only shown when we can tell people who the employer is.
  if (!name || UNNAMED_EMPLOYER.test(name)) {return null;}
  return name;
}

export function toIngestion(j: FleetJob): ExternalJobInput | null {
  const url = j.url || j.apply_url;
  const company = employerName(j.company_name);
  if (!j.title || !company || !url || !j.ats) {return null;}
  const description = j.description || '';
  return {
    title: j.title,
    company,
    location: j.location || (j.is_remote ? 'Remote' : ''),
    description,
    requirements: [],
    skills: extractSkillsFromText(`${j.title}\n${description}`),
    workType: j.is_remote ? 'remote' : 'onsite',
    salaryMin: j.salary_min ?? undefined,
    salaryMax: j.salary_max ?? undefined,
    source: `ATS:${j.ats}`,
    externalId: `fleet:${j.job_id}`,
    externalUrl: url,
    postedDate: j.posted_at || null,
  };
}

async function ingestOutbox(): Promise<string> {
  const raw = await download('outbox/latest.json.gz');
  if (!raw) {return 'no outbox yet';}
  const out = JSON.parse(gunzipSync(raw).toString('utf8')) as {
    generated_at: string; jobs: FleetJob[]; closed: string[];
    /** The Fleet's posting date for our undated jobs, by link fingerprint. */
    dates?: Record<string, string>;
    stats?: { catalog?: { jobs: number; companies: number } };
  };
  // Runs hourly because GitHub starts the matcher late or not at all; only a new outbox is processed.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS fleet_ingest_state (id int PRIMARY KEY, outbox_generated_at text NOT NULL, ingested_at timestamptz NOT NULL)`);
  const last = rows(await db.execute(sql`SELECT outbox_generated_at FROM fleet_ingest_state WHERE id = 1`))[0]?.outbox_generated_at;
  if (last === out.generated_at) {return `outbox ${out.generated_at} already ingested`;}
  // The deduplicated catalog count the homepage shows (computed by the matcher).
  const cat = out.stats?.catalog;
  if (cat && cat.jobs > 0) {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS catalog_stats (id int PRIMARY KEY, jobs int NOT NULL, companies int NOT NULL, computed_at timestamptz NOT NULL)`);
    await db.execute(sql`
      INSERT INTO catalog_stats (id, jobs, companies, computed_at) VALUES (1, ${cat.jobs}, ${cat.companies}, ${out.generated_at})
      ON CONFLICT (id) DO UPDATE SET jobs = EXCLUDED.jobs, companies = EXCLUDED.companies, computed_at = EXCLUDED.computed_at`);
  }
  // Posting dates the Fleet knows for our undated jobs. Fills only empty dates, through the same
  // guard as every other date (realPostedAt: no defaulted "now", no future, day-only at noon UTC).
  let fleetDated = 0;
  if (out.dates && Object.keys(out.dates).length) {
    const undated = rows(await db.execute(sql`
      SELECT source, external_url FROM job_postings WHERE status = 'active' AND posted_at IS NULL AND external_url IS NOT NULL`));
    const found = undated
      .map(u => ({ externalUrl: u.external_url as string, postedDate: out.dates![dateLookupKey(u.source, u.external_url).key] }))
      .filter(x => x.postedDate);
    fleetDated = await backfillPostedAt(found);
  }
  const all = out.jobs.map(toIngestion);
  const unnamed = all.filter(x => x === null).length;
  const mapped = all.filter((x): x is ExternalJobInput => x !== null);
  // Skip postings Recrutas already has: ingestion "adopts" an existing row with the same link,
  // which would overwrite our scraper's company name and key with the Fleet's (and our scraper
  // would flip them back every run). Recrutas's own copy wins.
  const existing = new Set<string>();
  for (let i = 0; i < mapped.length; i += 1000) {
    const urls = mapped.slice(i, i + 1000).map(j => j.externalUrl);
    const r = rows(await db.execute(sql`SELECT external_url FROM job_postings WHERE external_url IN (${sql.join(urls.map(u => sql`${u}`), sql`, `)})`));
    for (const x of r) {existing.add(x.external_url);}
  }
  const inputs = mapped.filter(j => !existing.has(j.externalUrl));
  // Fleet jobs we already hold keep their row, but take the Fleet's current company name: the
  // Fleet fixes names as it re-reads boards ("extrahopnetworks" → "ExtraHop"). Only rows whose
  // name actually changed are written.
  let renamed = 0;
  const ours = mapped.filter(j => existing.has(j.externalUrl));
  for (let i = 0; i < ours.length; i += 500) {
    const values = sql.join(ours.slice(i, i + 500).map(j => sql`(${j.externalId}, ${j.company})`), sql`, `);
    const r = await db.execute(sql`
      UPDATE job_postings AS jp SET company = v.c, updated_at = NOW()
      FROM (VALUES ${values}) AS v(eid, c)
      WHERE jp.external_id = v.eid AND jp.company IS DISTINCT FROM v.c`);
    renamed += Number((r as any)?.rowCount ?? (r as any)?.count ?? 0);
  }
  const dated = await backfillPostedAt(ours);
  const totals = { inserted: 0, duplicates: 0, errors: 0, skippedNonUS: 0, skippedBadUrl: 0 };
  for (let i = 0; i < inputs.length; i += 500) {
    const r = await jobIngestionService.ingestExternalJobs(inputs.slice(i, i + 500));
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) {totals[k] += r[k];}
  }
  // Attach the Fleet's vectors so the server's embedding job never has to embed these jobs.
  let vectors = 0;
  const withVec = out.jobs.filter(j => Array.isArray(j.vector) && j.vector.length === 384);
  for (let i = 0; i < withVec.length; i += 200) {
    const values = sql.join(withVec.slice(i, i + 200).map(j => sql`(${`fleet:${j.job_id}`}, ${JSON.stringify(j.vector)})`), sql`, `);
    const r = await db.execute(sql`
      UPDATE job_postings AS jp SET embedding = v.e::vector, vector_embedding = v.e, embedding_updated_at = NOW()
      FROM (VALUES ${values}) AS v(eid, e)
      WHERE jp.external_id = v.eid AND jp.embedding IS NULL`);
    vectors += Number((r as any)?.rowCount ?? (r as any)?.count ?? 0);
  }
  let closed = 0;
  if (out.closed.length) {
    const ids = out.closed.map(id => `fleet:${id}`);
    const r = await db.execute(sql`
      UPDATE job_postings SET status = 'closed', updated_at = NOW()
      WHERE external_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)}) AND status = 'active'`);
    closed = Number((r as any)?.rowCount ?? (r as any)?.count ?? 0);
  }
  await db.execute(sql`
    INSERT INTO fleet_ingest_state (id, outbox_generated_at, ingested_at) VALUES (1, ${out.generated_at}, NOW())
    ON CONFLICT (id) DO UPDATE SET outbox_generated_at = EXCLUDED.outbox_generated_at, ingested_at = NOW()`);
  return `outbox ${out.generated_at}: ${out.jobs.length} matched jobs → ${unnamed} skipped (employer not named), ${existing.size} already in Recrutas (kept ours), ${totals.inserted} new, ${totals.duplicates} duplicates, ` +
    `${totals.skippedNonUS} non-US, ${totals.skippedBadUrl} bad links, ${totals.errors} errors; ${vectors} vectors attached; ${renamed} renamed; ${dated} posting dates added; ${fleetDated} dates from the Fleet for our own jobs; ${closed} closed`;
}

const step = process.argv[2];
if (step === 'export' || step === 'ingest') {
  const startedAt = new Date();
  const pipeline = step === 'export' ? 'fleet-export' : 'fleet-ingest';
  (step === 'export' ? exportInbox() : ingestOutbox())
    .then(async message => {
      console.log(`[fleet-matcher] ${message}`);
      await recordPipelineRun({ pipeline, status: 'ok', startedAt, message });
      process.exit(0);
    })
    .catch(async err => {
      console.error(`[fleet-matcher] ${step} failed:`, err?.message ?? err);
      await recordPipelineRun({ pipeline, status: 'failed', startedAt, message: String(err?.message ?? err) }).catch(() => {});
      process.exit(1);
    });
}
