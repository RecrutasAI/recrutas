/**
 * Resolves the long-tail Adzuna jobs (small regional biz, staffing, franchise, gov)
 * that the rule-based resolver in `migrate-adzuna-links.ts` couldn't crack.
 *
 * Two LLM passes via local Ollama (free, private, no API quota):
 *   1. Classify: small_biz_resolvable | staffing_agency | franchise_location | gov_entity | other
 *      - drop-candidates (staffing/franchise/gov): set status='closed', source='dropped_low_quality'
 *      - small_biz_resolvable: proceed to pass 2
 *      - other: leave as-is
 *   2. Synthesize: ask LLM for 3–5 plausible company domains, HTTP HEAD each, first 2xx wins.
 *
 * Truth is the HTTP verifier, not the LLM — hallucinated domains fail HEAD and get discarded.
 *
 * Usage:
 *   npx tsx scripts/resolve-adzuna-with-llm.ts --sample 20 --dry-run     # validate accuracy
 *   npx tsx scripts/resolve-adzuna-with-llm.ts --limit 1000               # production batch
 *   npx tsx scripts/resolve-adzuna-with-llm.ts                            # full run
 *
 * Env:
 *   OLLAMA_URL     (default http://localhost:11434)
 *   OLLAMA_MODEL   (default mistral)
 */
import 'dotenv/config';
import postgres from 'postgres';

const DRY_RUN     = process.argv.includes('--dry-run');
const LIMIT_ARG   = process.argv.indexOf('--limit');
const SAMPLE_ARG  = process.argv.indexOf('--sample');
const MAX_JOBS    = LIMIT_ARG !== -1 ? parseInt(process.argv[LIMIT_ARG + 1], 10) : Infinity;
const SAMPLE_SIZE = SAMPLE_ARG !== -1 ? parseInt(process.argv[SAMPLE_ARG + 1], 10) : 0;

const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'mistral';

const CHUNK            = 50;
// Single-stream on CPU. Concurrent calls share one CPU and triple per-call
// latency, blowing past the timeout. On GPU, raise this to 4-8 (the LLM is fast
// enough that batching helps) and shrink LLM_TIMEOUT_MS to 30_000.
const LLM_CONCURRENCY  = 1;
const HTTP_CONCURRENCY = 8;
// CPU mistral with a ~200-token prompt: ~60-80s per call. Headroom for outliers.
const LLM_TIMEOUT_MS   = 180_000;
const HTTP_TIMEOUT_MS  = 6_000;

// ────────────────────────────────────────────────────────────────────────────
// Ollama wrapper
// ────────────────────────────────────────────────────────────────────────────

async function callOllama(prompt: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.1, num_predict: 512 },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const body = await res.json() as { response?: string };
    return body.response ?? '';
  } finally {
    clearTimeout(timer);
  }
}

function safeParseJson<T>(raw: string): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { /* try to extract */ }
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]) as T; } catch { return null; }
}

// ────────────────────────────────────────────────────────────────────────────
// Pass 1 — classification
// ────────────────────────────────────────────────────────────────────────────

type Category =
  | 'small_biz_resolvable'
  | 'staffing_agency'
  | 'franchise_location'
  | 'gov_entity'
  | 'other';

interface Classification {
  category: Category;
  confidence: number;
  reasoning?: string;
}

async function classifyJob(job: { title: string; company: string; location: string | null; description: string | null }): Promise<Classification | null> {
  const descSnippet = (job.description ?? '').slice(0, 600).replace(/\s+/g, ' ').trim();
  const prompt = `You are a job-listing classifier. Given a job, label the hiring entity into ONE category.

Categories:
- "staffing_agency": agency posting on behalf of unnamed client (e.g. "Robert Half", "Aerotek", "Kelly Services", language like "our client", "candidates for various roles")
- "franchise_location": individual franchise location of a larger brand (e.g. "McDonald's of Tulsa", "Domino's #4521", "Anytime Fitness location")
- "gov_entity": government employer (city, state, federal, school district, military, USPS, etc.)
- "small_biz_resolvable": specific small/mid business with a likely public website (independent shops, regional firms, named SMBs)
- "other": anything else, or unclear

Return ONLY JSON: {"category": "...", "confidence": 0.0-1.0, "reasoning": "short"}

Job:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location ?? ''}
Description: ${descSnippet}`;

  const raw = await callOllama(prompt);
  const parsed = safeParseJson<Classification>(raw);
  if (!parsed || !parsed.category) return null;
  return parsed;
}

// ────────────────────────────────────────────────────────────────────────────
// Pass 2 — URL synthesis
// ────────────────────────────────────────────────────────────────────────────

interface Synthesis { candidates: string[] }

async function synthesizeDomains(company: string, location: string | null): Promise<string[]> {
  const prompt = `Given a company name and location, propose 3-5 plausible public website domains.
Output bare domains only (no protocol, no path). Common patterns: companyname.com, company-name.com, companynamecity.com, abbreviation.com.

Return ONLY JSON: {"candidates": ["domain1.com", "domain2.com", ...]}

Company: ${company}
Location: ${location ?? ''}`;

  const raw = await callOllama(prompt);
  const parsed = safeParseJson<Synthesis>(raw);
  if (!parsed?.candidates) return [];
  return parsed.candidates
    .filter(d => typeof d === 'string')
    .map(d => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(d => /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d))
    .slice(0, 5);
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP verification
// ────────────────────────────────────────────────────────────────────────────

async function verifyDomain(domain: string): Promise<string | null> {
  const url = `https://${domain}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
    // Some hosts 405 HEAD — retry GET (range header to avoid full body)
    if (res.status === 405 || res.status === 403) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { Range: 'bytes=0-0' } });
    }
    if (res.status >= 200 && res.status < 400) return res.url || url;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function firstVerifiedDomain(candidates: string[]): Promise<string | null> {
  for (const d of candidates) {
    const verified = await verifyDomain(d);
    if (verified) return verified;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-job pipeline
// ────────────────────────────────────────────────────────────────────────────

type Outcome =
  | { kind: 'resolved'; url: string; source: 'career_page' }
  | { kind: 'dropped'; reason: Category }
  | { kind: 'kept' };

async function processJob(job: {
  id: number;
  title: string;
  company: string;
  location: string | null;
  description: string | null;
}): Promise<{ id: number; classification: Classification | null; outcome: Outcome }> {
  const classification = await classifyJob(job);
  if (!classification) {
    return { id: job.id, classification: null, outcome: { kind: 'kept' } };
  }

  // Drop low-quality categories with high enough confidence
  if (
    classification.confidence >= 0.6 &&
    (classification.category === 'staffing_agency' ||
      classification.category === 'franchise_location' ||
      classification.category === 'gov_entity')
  ) {
    return { id: job.id, classification, outcome: { kind: 'dropped', reason: classification.category } };
  }

  // Try resolution only for small-biz
  if (classification.category !== 'small_biz_resolvable') {
    return { id: job.id, classification, outcome: { kind: 'kept' } };
  }

  const candidates = await synthesizeDomains(job.company, job.location);
  if (candidates.length === 0) {
    return { id: job.id, classification, outcome: { kind: 'kept' } };
  }

  const verified = await firstVerifiedDomain(candidates);
  if (!verified) {
    return { id: job.id, classification, outcome: { kind: 'kept' } };
  }

  return { id: job.id, classification, outcome: { kind: 'resolved', url: verified, source: 'career_page' } };
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const sql = postgres(process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || '', { max: 3, prepare: false });

  // Probe Ollama is reachable before touching DB
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!r.ok) throw new Error(`Ollama tags returned ${r.status}`);
  } catch (e) {
    console.error(`Cannot reach Ollama at ${OLLAMA_URL}. Start it first (see docs/archive/OLLAMA_SETUP.md).`);
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }

  const [{ count }] = await sql<[{ count: string }]>`
    SELECT COUNT(*) as count FROM job_postings
    WHERE source = 'Adzuna' AND external_url LIKE '%adzuna%'
  `;
  const totalRemaining = parseInt(count, 10);
  const cap = SAMPLE_SIZE > 0 ? SAMPLE_SIZE : (MAX_JOBS === Infinity ? totalRemaining : Math.min(totalRemaining, MAX_JOBS));

  console.log(`Unresolved Adzuna jobs: ${totalRemaining}`);
  console.log(`Processing: ${cap}${SAMPLE_SIZE > 0 ? ' (sample mode)' : ''}`);
  console.log(`Model: ${OLLAMA_MODEL} @ ${OLLAMA_URL}`);
  if (DRY_RUN) console.log('DRY RUN — no DB writes\n'); else console.log('');

  let processed = 0;
  let resolved = 0;
  let dropped = 0;
  let kept = 0;
  let llmFailed = 0;
  const dropReasons: Record<string, number> = {};
  const samplePrints: Array<{ id: number; company: string; category: string; outcome: string; url?: string }> = [];

  const startedAt = Date.now();
  let lastId = 0;

  while (processed < cap) {
    const remaining = cap - processed;
    const chunkSize = Math.min(CHUNK, remaining);
    const jobs = SAMPLE_SIZE > 0
      ? await sql<Array<{ id: number; title: string; company: string; location: string | null; description: string | null }>>`
          SELECT id, title, company, location, description
          FROM job_postings
          WHERE source = 'Adzuna' AND external_url LIKE '%adzuna%'
          ORDER BY RANDOM()
          LIMIT ${chunkSize}
        `
      : await sql<Array<{ id: number; title: string; company: string; location: string | null; description: string | null }>>`
          SELECT id, title, company, location, description
          FROM job_postings
          WHERE source = 'Adzuna' AND external_url LIKE '%adzuna%' AND id > ${lastId}
          ORDER BY id
          LIMIT ${chunkSize}
        `;
    if (jobs.length === 0) break;
    if (SAMPLE_SIZE === 0) lastId = jobs[jobs.length - 1].id;

    // Process jobs with LLM concurrency cap
    const results: Array<Awaited<ReturnType<typeof processJob>>> = [];
    for (let i = 0; i < jobs.length; i += LLM_CONCURRENCY) {
      const slice = jobs.slice(i, i + LLM_CONCURRENCY);
      const sliceResults = await Promise.all(slice.map(j => processJob(j).catch(() => {
        llmFailed++;
        return { id: j.id, classification: null, outcome: { kind: 'kept' as const } };
      })));
      results.push(...sliceResults);
    }

    // Bucket outcomes
    const resolvedRows: Array<{ id: number; url: string }> = [];
    const droppedIds: number[] = [];
    for (const r of results) {
      if (r.outcome.kind === 'resolved') {
        resolved++;
        resolvedRows.push({ id: r.id, url: r.outcome.url });
      } else if (r.outcome.kind === 'dropped') {
        dropped++;
        dropReasons[r.outcome.reason] = (dropReasons[r.outcome.reason] ?? 0) + 1;
        droppedIds.push(r.id);
      } else {
        kept++;
      }

      // Sample prints (first 20 of any run)
      if (samplePrints.length < 20) {
        const company = jobs.find(j => j.id === r.id)?.company ?? '';
        samplePrints.push({
          id: r.id,
          company,
          category: r.classification?.category ?? 'classify_failed',
          outcome: r.outcome.kind,
          url: r.outcome.kind === 'resolved' ? r.outcome.url : undefined,
        });
      }
    }

    if (!DRY_RUN && resolvedRows.length > 0) {
      const ids = resolvedRows.map(r => r.id);
      const urls = resolvedRows.map(r => r.url);
      await sql`
        UPDATE job_postings AS jp
        SET external_url = v.url, source = 'career_page'
        FROM unnest(${sql.array(ids)}::int[], ${sql.array(urls)}::text[]) AS v(id, url)
        WHERE jp.id = v.id
      `;
    }
    if (!DRY_RUN && droppedIds.length > 0) {
      await sql`
        UPDATE job_postings
        SET status = 'closed'
        WHERE id = ANY(${sql.array(droppedIds)}::int[])
      `;
    }

    processed += jobs.length;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    const pct = ((processed / cap) * 100).toFixed(1);
    const line = `[${elapsed}s] ${processed}/${cap} (${pct}%) | resolved=${resolved} dropped=${dropped} kept=${kept} llm_fail=${llmFailed}`;
    if (process.env.CI) console.log(line);
    else process.stdout.write(`\r${line}   `);
  }

  console.log(`\n\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`Resolved (new URL):  ${resolved}/${processed} (${((resolved / processed) * 100).toFixed(1)}%)`);
  console.log(`Dropped (low-qual):  ${dropped}/${processed} (${((dropped / processed) * 100).toFixed(1)}%)`);
  console.log(`Kept (Adzuna URL):   ${kept}/${processed} (${((kept / processed) * 100).toFixed(1)}%)`);
  console.log(`LLM failures:        ${llmFailed}`);
  if (Object.keys(dropReasons).length > 0) {
    console.log('Drop reasons:');
    for (const [reason, n] of Object.entries(dropReasons)) console.log(`  ${reason}: ${n}`);
  }

  if (SAMPLE_SIZE > 0 || DRY_RUN) {
    console.log('\nSample of classifications:');
    for (const s of samplePrints) {
      const tail = s.url ? ` → ${s.url}` : '';
      console.log(`  #${s.id} [${s.category}] (${s.outcome})  ${s.company.slice(0, 50)}${tail}`);
    }
    console.log('\nReview the sample above. If accuracy looks right, run without --sample/--dry-run.');
  }

  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
