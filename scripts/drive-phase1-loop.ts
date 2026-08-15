/**
 * Drive the PHASE 1 candidate loop end-to-end over real HTTP, as a real new user.
 *
 * Phase 1 is the candidate dashboard only (see the launch phases): sign up →
 * guided setup → résumé upload → parse → match → feed → profile. No employer
 * side, no exam, no chat — those are phase 2 and are deliberately not exercised.
 *
 * Unlike scripts/drive-core-loop.ts (which calls services directly), this goes
 * through the HTTP layer with a real Supabase JWT, because the phase-1 funnel
 * dies at signup → résumé upload and that stretch is auth + transport, not
 * service wiring. A service-level pass would not have caught it.
 *
 * ⚠️  Writes to the PRODUCTION database and creates a real auth user.
 *     Cleans up everything it creates unless --keep is passed.
 *
 * Usage:
 *   npx tsx scripts/drive-phase1-loop.ts
 *   npx tsx scripts/drive-phase1-loop.ts --keep
 */

import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';

const KEEP = process.argv.includes('--keep');
const BASE = process.env.PHASE1_BASE_URL || 'http://localhost:5000';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const RESUME_PDF = process.env.PHASE1_RESUME || 'Resume-Sample-1-Software-Engineer.pdf';

let pass = 0, fail = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}
const section = (n: string) => console.log(`\n\x1b[1m${n}\x1b[0m`);

async function main() {
  if (!SUPABASE_URL || !ANON || !SERVICE) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY');
  }

  const email = `phase1-e2e-${Date.now()}@example.com`;
  const password = `Test!${randomUUID().slice(0, 12)}Aa1`;
  let userId = '';
  let token = '';

  try {
    // ── 1. Signup ───────────────────────────────────────────────────────────
    section('1. Signup (mirrors client/src/components/SignUpForm.tsx)');
    const signupRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email, password,
        data: { role: 'candidate', first_name: 'Phase', last_name: 'One', full_name: 'Phase One' },
      }),
    });
    const signup = await signupRes.json();
    check('signup returns 200', signupRes.ok, `HTTP ${signupRes.status}`);
    if (!signupRes.ok) { console.log(JSON.stringify(signup).slice(0, 400)); return; }

    userId = signup.user?.id || signup.id || '';
    token = signup.access_token || '';
    check('auth user created', !!userId, userId);

    // The single most load-bearing field in phase-1 onboarding: /guided-setup
    // picks the candidate vs employer flow from this, and RoleGuard gates
    // /candidate-dashboard on it.
    const meta = signup.user?.user_metadata || signup.user_metadata || {};
    check("user_metadata.role === 'candidate'", meta.role === 'candidate', `got ${JSON.stringify(meta.role)}`);

    if (!token) {
      // Email confirmation is on — sign in is impossible without the mailbox.
      check('signup returns a session (email confirmation OFF)', false,
        'no access_token; the flow cannot continue without confirming email');
      return;
    }
    check('signup returns a usable session', !!token);

    const auth = { apikey: ANON, Authorization: `Bearer ${token}` };

    // ── 2. DB bootstrap ─────────────────────────────────────────────────────
    section('2. /api/auth/sync — bootstrap the DB user record');
    const syncRes = await fetch(`${BASE}/api/auth/sync`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
    });
    check('auth/sync succeeds', syncRes.ok, `HTTP ${syncRes.status}`);

    // ── 3. Guided setup gate ────────────────────────────────────────────────
    section('3. Guided-setup flow selection');
    // The page resolves role from the session; assert the server agrees, since a
    // mismatch is what put candidates into the employer flow.
    const roleRes = await fetch(`${BASE}/api/candidate/profile`, { headers: auth });
    check('candidate profile endpoint reachable as candidate', roleRes.ok, `HTTP ${roleRes.status}`);
    check('role resolves to candidate → candidate steps (Resume → Profile)', meta.role === 'candidate');

    // ── 4. Résumé upload ────────────────────────────────────────────────────
    section(`4. Résumé upload (${RESUME_PDF})`);
    const pdf = readFileSync(RESUME_PDF);
    const form = new FormData();
    form.append('resume', new Blob([pdf], { type: 'application/pdf' }), 'resume.pdf');
    const upStart = Date.now();
    const upRes = await fetch(`${BASE}/api/candidate/resume`, { method: 'POST', headers: auth, body: form });
    const upBody = await upRes.json().catch(() => ({}));
    check('resume upload returns 200', upRes.ok, `HTTP ${upRes.status} in ${Date.now() - upStart}ms`);
    if (!upRes.ok) console.log('   ', JSON.stringify(upBody).slice(0, 300));
    check('resume stored (resumeUrl returned)', !!upBody.resumeUrl, upBody.resumeUrl ? 'yes' : 'MISSING');

    // ── 5. Parse ────────────────────────────────────────────────────────────
    section('5. Résumé parsing');
    let profile: any = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const r = await fetch(`${BASE}/api/candidate/profile`, { headers: auth });
      // The endpoint answers `{ exists, profile }`. Unwrap exactly the way
      // fetchProfileWithCache does on the client — reading the raw body here is
      // the very bug this run uncovered in ResumeUploadStep.
      const body = await r.json().catch(() => null);
      profile = body?.profile ?? (body?.exists === false ? null : body);
      if (profile?.resumeProcessingStatus === 'completed' || profile?.resumeProcessingStatus === 'failed') break;
      await new Promise(res => setTimeout(res, 3000));
    }
    check('parsing reached a terminal state', ['completed', 'failed'].includes(profile?.resumeProcessingStatus),
      `status=${profile?.resumeProcessingStatus}`);
    check('parsing completed (not failed)', profile?.resumeProcessingStatus === 'completed');

    const skills: string[] = profile?.skills || [];
    check('skills extracted', skills.length > 0, `${skills.length} skills: ${skills.slice(0, 6).join(', ')}`);

    const parsing = profile?.resumeParsingData || {};
    // Provenance — the uncommitted work that makes a degraded parse visible.
    check('parse records which engine produced it', !!parsing.extractor, `extractor=${parsing.extractor}`);
    check('parse was NOT degraded', parsing.degraded === false,
      `degraded=${parsing.degraded}${parsing.primaryError ? ` (${String(parsing.primaryError).slice(0, 120)})` : ''}`);
    check('parse used an AI engine, not the rule fallback',
      parsing.extractor === 'gemini-multimodal' || parsing.extractor === 'ai-text',
      `extractor=${parsing.extractor}`);

    const positions = parsing.positions || profile?.workExperience || [];
    check('work positions extracted', positions.length > 0, `${positions.length} positions`);
    if (positions.length) {
      // The bug fixed in 3be8788: titles were taken by line position, so the
      // company name landed in the title field.
      const titles = positions.map((p: any) => p.title).filter(Boolean);
      const companies = positions.map((p: any) => p.company).filter(Boolean);
      console.log(`      titles:    ${JSON.stringify(titles.slice(0, 4))}`);
      console.log(`      companies: ${JSON.stringify(companies.slice(0, 4))}`);
      check('titles are not identical to companies (line-position bug)',
        !titles.length || !titles.every((t: string, i: number) => t === companies[i]));
    }

    // ── 6. Matching ─────────────────────────────────────────────────────────
    section('6. Matching');
    let matches: any[] = [];
    const mDeadline = Date.now() + 60_000;
    while (Date.now() < mDeadline) {
      const r = await fetch(`${BASE}/api/ai-matches`, { headers: auth });
      const body = await r.json().catch(() => []);
      // /api/ai-matches answers `{ jobs, total, page, hasMore }` — the key is
      // `jobs`, not `matches`.
      matches = Array.isArray(body) ? body : (body.jobs || body.matches || []);
      if (matches.length) break;
      await new Promise(res => setTimeout(res, 3000));
    }
    check('candidate has job matches', matches.length > 0, `${matches.length} matches`);
    if (matches.length) {
      // Shape per formatJobMatch (routes.ts:429): `{ id, job: {...}, matchScore: "N%" }`.
      // matchScore is a STRING with a percent sign, not a number.
      const m = matches[0];
      const job = m.job || {};
      const scoreNum = parseInt(String(m.matchScore), 10);
      console.log(`      top match: "${job.title}" @ ${job.company} (score ${m.matchScore})`);
      const scores = matches.map((x: any) => parseInt(String(x.matchScore), 10)).filter((n: number) => !isNaN(n));
      const nonZero = scores.filter((n: number) => n > 0).length;
      console.log(`      scores: max=${Math.max(...scores)} min=${Math.min(...scores)} nonzero=${nonZero}/${scores.length}`);

      check('top match has a real title/company', !!job.title && !!job.company, `${job.title} @ ${job.company}`);
      check('top match scores above zero', scoreNum > 0, `top=${m.matchScore}`);
      // A feed where most rows score 0 is indistinguishable from an unranked
      // list — the ranking is the product.
      check('most matches score above zero', nonZero > scores.length / 2, `${nonZero}/${scores.length} nonzero`);
      check('matches link to a real job URL', !!(job.externalUrl || job.careerPageUrl),
        job.externalUrl || job.careerPageUrl || 'MISSING');
      check('skill overlap is reported', Array.isArray(m.skillMatches), `${(m.skillMatches||[]).length} skill matches`);
    }

    // ── 7. Feed ─────────────────────────────────────────────────────────────
    section('7. Job feed');
    const feedRes = await fetch(`${BASE}/api/external-jobs?limit=8`, { headers: auth });
    const feed = await feedRes.json().catch(() => ({}));
    const jobs = Array.isArray(feed) ? feed : (feed.jobs || []);
    check('feed returns jobs', jobs.length > 0, `${jobs.length} jobs`);
    check('feed honours ?limit=8', jobs.length <= 8, `got ${jobs.length}`);
    if (jobs.length) {
      const withUrl = jobs.filter((j: any) => j.externalUrl || j.applicationUrl || j.url).length;
      check('every feed job has an apply URL', withUrl === jobs.length, `${withUrl}/${jobs.length}`);
      const rendered = jobs.filter((j: any) => /<[a-z][\s\S]*>|\*\*/i.test(j.description || '')).length;
      check('no raw markup leaking into descriptions', rendered === 0, `${rendered} with markup`);
    }

    // ── 8. Profile surface ──────────────────────────────────────────────────
    section('8. Profile');
    check('profile readable', !!profile, `skills=${skills.length}`);
    check('profile carries the résumé', !!profile?.resumeUrl);

  } finally {
    section('Cleanup');
    if (KEEP) {
      console.log(`  ⏭️  --keep: leaving user ${userId} (${email}) in place`);
    } else if (userId) {
      const del = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      });
      console.log(`  ${del.ok ? '✅' : '❌'} deleted auth user ${userId} (HTTP ${del.status})`);
      const { db, client } = await import('../server/db.js');
      const { users, candidateProfiles, jobMatches } = await import('@shared/schema');
      const { eq } = await import('drizzle-orm');
      await db.delete(jobMatches).where(eq(jobMatches.candidateId, userId)).catch(() => {});
      await db.delete(candidateProfiles).where(eq(candidateProfiles.userId, userId)).catch(() => {});
      await db.delete(users).where(eq(users.id, userId)).catch(() => {});
      console.log('  ✅ deleted DB rows (matches, profile, user)');
      await client.end();
    }

    console.log(`\n\x1b[1mPHASE 1 RESULT: ${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) {
      console.log('\nFailures:');
      failures.forEach(f => console.log(`  • ${f}`));
    }
    process.exit(fail > 0 ? 1 : 0);
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
