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
import { jobIngestionService, type ExternalJobInput } from '../server/services/job-ingestion.service';
import { extractSkillsFromText } from '../server/utils/skill-extractor';
import { recordPipelineRun } from '../server/services/pipeline-run.service';

const DATASET = process.env.MATCHER_DATASET || 'recrutas/matcher';
const HF = 'https://huggingface.co';
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

function need(name: string): string {
  const v = process.env[name];
  if (!v) {throw new Error(`${name} is not set`);}
  return v;
}

export function pseudonym(userId: string, key: string): string {
  return createHmac('sha256', key).update(userId).digest('hex').slice(0, 32);
}

/** Commit one small file to the dataset (the inbox is a few KB per hundred users). */
async function upload(path: string, content: string, summary: string): Promise<void> {
  const body = [
    JSON.stringify({ key: 'header', value: { summary } }),
    JSON.stringify({ key: 'file', value: { path, content: Buffer.from(content).toString('base64'), encoding: 'base64' } }),
  ].join('\n');
  const r = await fetch(`${HF}/api/datasets/${DATASET}/commit/main`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${need('HF_TOKEN')}`, 'Content-Type': 'application/x-ndjson' },
    body,
  });
  if (!r.ok) {throw new Error(`upload ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);}
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
  await upload('inbox/candidates.json', JSON.stringify(inbox), `Inbox: ${inbox.candidates.length} users, ${inbox.held.length} shown Fleet jobs`);
  return `exported ${inbox.candidates.length} users, ${inbox.held.length} shown Fleet jobs`;
}

interface FleetJob {
  job_id: string; title: string | null; company_name: string | null; location: string | null; description: string | null;
  url: string | null; apply_url: string | null; ats: string | null; posted_at: string | null; is_remote: boolean | null;
  salary_min: number | null; salary_max: number | null; vector: number[];
}

export function toIngestion(j: FleetJob): ExternalJobInput | null {
  const url = j.url || j.apply_url;
  if (!j.title || !j.company_name || !url || !j.ats) {return null;}
  const description = j.description || '';
  return {
    title: j.title,
    company: j.company_name,
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
    postedDate: j.posted_at || new Date().toISOString(),
  };
}

async function ingestOutbox(): Promise<string> {
  const raw = await download('outbox/latest.json.gz');
  if (!raw) {return 'no outbox yet';}
  const out = JSON.parse(gunzipSync(raw).toString('utf8')) as { generated_at: string; jobs: FleetJob[]; closed: string[] };
  const inputs = out.jobs.map(toIngestion).filter((x): x is ExternalJobInput => x !== null);
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
  return `outbox ${out.generated_at}: ${out.jobs.length} matched jobs → ${totals.inserted} new, ${totals.duplicates} already here, ` +
    `${totals.skippedNonUS} non-US, ${totals.skippedBadUrl} bad links, ${totals.errors} errors; ${vectors} vectors attached; ${closed} closed`;
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
