/**
 * Measure the deterministic (rules) resume parser against the AI parse of the
 * same resume, on real candidates. Read-only.
 *
 * The rules engine only runs when every AI provider has failed, so its output
 * is what a user sees on a bad day. This scores it against the AI result:
 *   - positions: recall/precision of job titles (token overlap ≥ 0.5)
 *   - company:   share of matched positions whose employer also matches
 *   - junk:      rules titles that can't be a job title (IDs, sentences, URLs…)
 *   - dupes:     repeated title+company pairs
 *   - skills:    share of the AI's skills the rules parser also found
 *
 *   npx tsx scripts/eval-rules-parser.ts              # stored AI parses only
 *   npx tsx scripts/eval-rules-parser.ts --ai-ref     # also ask Groq for a
 *                                                     # reference where none is stored
 *   EVAL_VERBOSE=1 …                                  # per-resume title diff
 *
 * Prints only titles, employers and scores, never resume text.
 */
import { db } from '../server/db';
import { sql } from "drizzle-orm/sql";
import { AIResumeParser } from '../server/ai-resume-parser';

type Pos = { title?: string; company?: string };
const norm = (s = ''): string[] => s.toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').split(/\s+/).filter(w => w.length > 1);
function overlap(a = '', b = ''): number {
  const A = new Set(norm(a)), B = new Set(norm(b));
  if (!A.size || !B.size) {return 0;}
  let inter = 0; for (const w of A) {if (B.has(w)) {inter++;}}
  return inter / Math.min(A.size, B.size);
}
const JUNK_RE = /[#@]|https?:|www\.|\b[0-9a-f]{8}-[0-9a-f]{4}\b|\.\s*$|[|•]|^(skills|experience|education|summary)\b/i;
export function isJunkTitle(t = ''): boolean {
  const words = t.trim().split(/\s+/).length;
  return !t.trim() || t.length > 70 || words > 9 || JUNK_RE.test(t);
}
// An employer is a name, not a paragraph.
const isJunkCompany = (c = ''): boolean => c.length > 80 || c.trim().split(/\s+/).length > 10
  || /https?:|@|\+\d{1,3}[\s.-]?\d|\d{3}[\s.-]?\d{3}[\s.-]?\d{4}|\b(experience|education|skills)\s*$/i.test(c);

function score(rules: Pos[], ai: Pos[]) {
  const matchedAi = new Set<number>();
  let truePos = 0, companyOk = 0;
  for (const r of rules) {
    let best = -1, bestScore = 0;
    ai.forEach((a, i) => { const s = overlap(r.title, a.title); if (s > bestScore && !matchedAi.has(i)) {bestScore = s; best = i;} });
    if (best >= 0 && bestScore >= 0.5) {
      matchedAi.add(best); truePos++;
      if (overlap(r.company, ai[best].company) >= 0.5) {companyOk++;}
    }
  }
  const keys = rules.map(r => `${(r.title || '').toLowerCase()}|${(r.company || '').toLowerCase()}`);
  return {
    recall: ai.length ? truePos / ai.length : (rules.length ? 0 : 1),
    precision: rules.length ? truePos / rules.length : (ai.length ? 0 : 1),
    company: truePos ? companyOk / truePos : (ai.length ? 0 : 1),
    junk: rules.filter(r => isJunkTitle(r.title) || isJunkCompany(r.company)).length,
    dupes: keys.length - new Set(keys).size,
  };
}

(async () => {
  const withAiRef = process.argv.includes('--ai-ref');
  const verbose = !!process.env.EVAL_VERBOSE;
  const parser: any = new AIResumeParser();
  const rows: any = await db.execute(sql`
    SELECT user_id, resume_text, resume_parsing_data AS rpd, skills
    FROM candidate_users
    WHERE resume_text IS NOT NULL AND length(resume_text) > 200
    ORDER BY user_id`);
  const list = (rows.rows ?? rows) as any[];
  const totals = { n: 0, recall: 0, precision: 0, company: 0, junk: 0, dupes: 0, skills: 0, rulesPos: 0, aiPos: 0 };

  for (const [i, r] of list.entries()) {
    let aiPositions: Pos[] | null = null; let aiSkills: string[] = [];
    if (r.rpd?.extractor === 'ai-text' || r.rpd?.extractor === 'gemini-multimodal') {
      aiPositions = r.rpd.positions || [];
      aiSkills = Array.isArray(r.skills) ? r.skills : [];
    } else if (withAiRef) {
      const ai = await parser.parseText(r.resume_text);
      if (ai.extractor === 'ai-text') {
        aiPositions = ai.aiExtracted?.experience?.positions || [];
        const s = ai.aiExtracted?.skills || {};
        aiSkills = [...(s.technical || []), ...(s.tools || []), ...(s.soft || [])];
      }
    }
    if (!aiPositions) {continue;}

    const rules = await parser.extractWithFallback(r.resume_text);
    const rPos: Pos[] = rules.experience?.positions || [];
    const rSkills = new Set([...(rules.skills?.technical || []), ...(rules.skills?.tools || []), ...(rules.skills?.soft || [])].map((s: string) => s.toLowerCase()));
    const sc = score(rPos, aiPositions);
    const skillRecall = aiSkills.length ? aiSkills.filter(s => rSkills.has(String(s).toLowerCase())).length / aiSkills.length : 1;

    totals.n++; totals.recall += sc.recall; totals.precision += sc.precision; totals.company += sc.company;
    totals.junk += sc.junk; totals.dupes += sc.dupes; totals.skills += skillRecall;
    totals.rulesPos += rPos.length; totals.aiPos += aiPositions.length;

    console.log(`#${i + 1} ai=${aiPositions.length} rules=${rPos.length} recall=${sc.recall.toFixed(2)} precision=${sc.precision.toFixed(2)} company=${sc.company.toFixed(2)} junk=${sc.junk} dupes=${sc.dupes} skills=${skillRecall.toFixed(2)}`);
    if (verbose) {
      console.log('   AI   :', JSON.stringify(aiPositions.map(p => `${p.title} @ ${p.company}`)));
      console.log('   rules:', JSON.stringify(rPos.map(p => `${p.title} @ ${p.company}`)));
    }
  }
  const avg = (x: number) => (totals.n ? (x / totals.n).toFixed(2) : '-');
  console.log(`\nRESUMES ${totals.n} | positions ai=${totals.aiPos} rules=${totals.rulesPos} | title recall ${avg(totals.recall)} | precision ${avg(totals.precision)} | company ${avg(totals.company)} | junk titles ${totals.junk} | dupes ${totals.dupes} | skill recall ${avg(totals.skills)}`);
  process.exit(0);
})();
