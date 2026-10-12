/**
 * The shared map of application-question wordings to the fact they ask (question_topics).
 *
 * The fixed rules in server/lib/autofill-truth.ts place most questions. A wording they miss is
 * classified once by a small AI call and stored, so every later form that uses it is placed
 * at once, for everyone. The table holds question text only, never anyone's answer.
 *
 * Never slows or breaks a fill: lookups and the AI call share one time budget, and any failure
 * returns what is known so far (the rules alone).
 */
import { sql } from 'drizzle-orm/sql';
import { db } from '../db';
import { callAI } from '../lib/ai-client';
import { FACT_MEANINGS, labelKey, needsTopic, type Fact, type FillField } from '../lib/autofill-truth';

const FACTS = Object.keys(FACT_MEANINGS) as Array<Exclude<Fact, 'other'>>;
const MAX_NEW = 25;  // wordings classified per fill; the rest wait for a later one

export async function topicsFor(fields: FillField[], budgetMs = 6000): Promise<Map<string, Fact | 'none'>> {
  const known = new Map<string, Fact | 'none'>();
  const labels = new Map<string, string>();  // key → label as written
  for (const f of fields) {if (needsTopic(f)) {labels.set(labelKey(f.label || ''), (f.label || '').trim().slice(0, 300));}}
  if (!labels.size || !db) {return known;}

  const deadline = Date.now() + budgetMs;
  const within = <T>(p: Promise<T>): Promise<T | null> => Promise.race([
    p, new Promise<null>(resolve => setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))),
  ]);
  try {
    const keys = [...labels.keys()];
    const rows: any = await within(db.execute(sql`
      UPDATE question_topics SET seen = seen + 1, last_seen = NOW()
      WHERE label_norm IN ${keys} RETURNING label_norm, fact`));
    for (const r of (rows?.rows ?? rows ?? []) as Array<{ label_norm: string; fact: string }>) {
      if (r.fact === 'none' || (FACTS as string[]).includes(r.fact)) {known.set(r.label_norm, r.fact as Fact | 'none');}
    }
    const unknown = keys.filter(k => !known.has(k)).slice(0, MAX_NEW);
    if (!unknown.length) {return known;}

    const decided = await within(classify(unknown.map(k => labels.get(k)!)));
    if (!decided) {return known;}
    const values = unknown.map((k, i) => ({ k, fact: decided[i] })).filter(v => v.fact);
    for (const v of values) {known.set(v.k, v.fact!);}
    if (values.length) {
      await within(db.execute(sql`
        INSERT INTO question_topics (label_norm, fact, decided_by)
        VALUES ${sql.join(values.map(v => sql`(${v.k}, ${v.fact}, 'ai')`), sql`, `)}
        ON CONFLICT (label_norm) DO NOTHING`));
    }
  } catch (err) {
    console.warn('[question-topics] skipped, rules only:', (err as Error).message);
  }
  return known;
}

/** One AI call: for each question, the fact it asks about the candidate, or 'none'. */
export async function classify(questions: string[]): Promise<Array<Fact | 'none' | undefined>> {
  const system = `You sort job application questions by the fact about the applicant they ask for.
Facts:
${FACTS.map(f => `- ${f}: ${FACT_MEANINGS[f]}`).join('\n')}
- none: anything else (a skill or experience question, a question about the job, an opinion, a form instruction)
Return ONLY JSON: {"results": [{"i": <question number>, "fact": "<one fact key or none>"}]}`;
  const user = questions.map((q, i) => `${i}. ${q}`).join('\n');
  const raw = await callAI(system, user, { temperature: 0, maxOutputTokens: 800, priority: 'low' });
  const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const out: Array<Fact | 'none' | undefined> = questions.map(() => undefined);
  for (const r of Array.isArray(json?.results) ? json.results : []) {
    const i = Number(r?.i);
    const fact = String(r?.fact ?? '');
    if (Number.isInteger(i) && i >= 0 && i < questions.length && (fact === 'none' || (FACTS as string[]).includes(fact))) {out[i] = fact as Fact | 'none';}
  }
  return out;
}
