/**
 * @fileoverview ATS probe circuit-breaker regression tests.
 *
 * Run:  npx tsx test/ats-probe-circuit.test.ts
 *
 * Guards the fixes for the probe backlog stall (Jul 2026), where the probe was
 * draining only ~30 of 15,515 pending companies per day AND permanently
 * rejecting companies it had never actually checked:
 *
 *   1. A 429 must NOT be reported as "no ATS" — the caller rejects on a null
 *      atsType, so a rate limit used to silently burn a company forever.
 *   2. One provider's open circuit must not block discovery via other providers
 *      (the breaker used to be global across all seven).
 *   3. A genuine all-404 sweep must still be a real rejection, so `inconclusive`
 *      can't quietly stop the backlog from ever draining.
 *
 * Network is stubbed for ATS hosts only; redis is forced to its in-process
 * fallback so the run never touches shared state.
 */
// Force the in-process redis fallback so our fetch stub can't break Upstash's
// own HTTP transport (and so the test never touches shared prod state).
// Set (don't delete) — dotenv.config() only fills in keys that are ABSENT, so an
// empty string here survives and forces redis's in-process fallback.
process.env.UPSTASH_REDIS_REST_URL = '';
process.env.UPSTASH_REDIS_REST_TOKEN = '';

const { probeCompany } = await import('../server/lib/ats-probe.js');
const { redis } = await import('../server/lib/redis.js');

type Handler = (url: string) => { status: number; body?: unknown };
let handler: Handler = () => ({ status: 404 });

const realFetch = globalThis.fetch.bind(globalThis);
const ATS_HOSTS = /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|recruitee\.com|smartrecruiters\.com|breezy\.hr|clearbit|autocomplete/i;

(globalThis as any).fetch = async (url: string | URL, init?: any) => {
  const u = typeof url === 'string' ? url : url.toString();
  // Let Upstash (and anything else non-ATS) talk to the real network.
  if (!ATS_HOSTS.test(u)) return realFetch(url as any, init);
  const { status, body } = handler(u);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body ?? null,
    text: async () => (body ? JSON.stringify(body) : ''),
  } as any;
};

const results: string[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`);
}

async function clearCircuits() {
  for (const p of ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'breezy']) {
    await redis.set(`ats-probe:circuit-pause-until:${p}`, '0', 1);
    await redis.set(`ats-probe:consecutive-429s:${p}`, '0', 1);
  }
  await redis.set('ats-probe:circuit-pause-until', '0', 1); // legacy global key
  await redis.set('ats-probe:consecutive-429s', '0', 1);
}

async function main() {
  // ── 1. Greenhouse 429s, everything else genuinely 404 ──────────────────────
  await clearCircuits();
  handler = (u) => (u.includes('greenhouse.io') ? { status: 429 } : { status: 404 });
  let r = await probeCompany('acme rate limited co');
  check(
    '429 yields inconclusive (not a rejection)',
    r.inconclusive === true && r.atsType === null,
    `got inconclusive=${r.inconclusive} atsType=${r.atsType}`
  );

  // ── 2. Greenhouse circuit OPEN, company really is on Lever ─────────────────
  await clearCircuits();
  await redis.set('ats-probe:circuit-pause-until:greenhouse', String(Date.now() + 60_000), 65);
  // Also set the pre-fix GLOBAL key, so this is a fair old-vs-new comparison:
  // old code saw any open circuit and abandoned the company entirely.
  await redis.set('ats-probe:circuit-pause-until', String(Date.now() + 60_000), 65);
  handler = (u) => {
    if (u.includes('greenhouse.io')) return { status: 429 };
    if (u.includes('api.lever.co')) return { status: 200, body: [] }; // valid Lever board
    return { status: 404 };
  };
  r = await probeCompany('leverco');
  check(
    'paused provider does not block discovery on another provider',
    r.atsType === 'lever' && !r.inconclusive,
    `got atsType=${r.atsType} inconclusive=${r.inconclusive}`
  );

  // ── 3. Genuine "no ATS anywhere" must stay a real rejection ────────────────
  await clearCircuits();
  handler = () => ({ status: 404 });
  r = await probeCompany('definitely not a company xyz');
  check(
    'genuine all-404 stays a real rejection (not inconclusive)',
    r.atsType === null && !r.inconclusive,
    `got atsType=${r.atsType} inconclusive=${r.inconclusive}`
  );

  // ── 4. Greenhouse detection uses the API host ──────────────────────────────
  // boards.greenhouse.io 301s for every slug (real or nonsense) and then hits
  // bot protection, so it can never yield a positive. Only boards-api answers
  // truthfully. Serving 200 ONLY from the HTML host must not count as a match.
  await clearCircuits();
  const greenhouseHostsHit: string[] = [];
  handler = (u) => {
    if (u.includes('greenhouse')) greenhouseHostsHit.push(u);
    if (u.includes('boards-api.greenhouse.io')) {
      return { status: 200, body: { jobs: [], meta: { total: 0 } } };
    }
    if (u.includes('boards.greenhouse.io')) return { status: 200 }; // decoy
    return { status: 404 };
  };
  r = await probeCompany('greenhouseco');
  check(
    'greenhouse detected via boards-api (not the dead HTML host)',
    r.atsType === 'greenhouse' &&
      greenhouseHostsHit.some(u => u.includes('boards-api.greenhouse.io')) &&
      !greenhouseHostsHit.some(u => /\/\/boards\.greenhouse\.io/.test(u)),
    `atsType=${r.atsType} hosts=${JSON.stringify(greenhouseHostsHit.slice(0, 3))}`
  );

  // ── 5. An empty-but-real greenhouse board still counts as a real board ─────
  await clearCircuits();
  handler = (u) =>
    u.includes('boards-api.greenhouse.io')
      ? { status: 404 }   // unknown board
      : { status: 404 };
  r = await probeCompany('nosuchboard');
  check(
    'unknown greenhouse board is not a match',
    r.atsType === null && !r.inconclusive,
    `got atsType=${r.atsType} inconclusive=${r.inconclusive}`
  );

  // ── 6. A persistently blocked provider stops blocking every verdict ────────
  // Workable 429s even for sequential requests on known-good slugs (it blocks us
  // at the account/IP level). If its coverage stays mandatory, EVERY company is
  // inconclusive forever and the backlog never drains. After it trips repeatedly
  // we must be able to reach a verdict on the remaining providers.
  // Runs last: degraded state is per-run and intentionally not reset here.
  await clearCircuits();
  handler = (u) => (u.includes('workable') ? { status: 429 } : { status: 404 });

  let sawInconclusiveEarly = false;
  let reachedVerdictAfterDegrade = false;
  for (let i = 0; i < 8; i++) {
    // Expire only the circuit, keeping the 429 counter hot — this reproduces the
    // real pattern where the 60s pause lapses and the provider instantly re-trips.
    await redis.set('ats-probe:circuit-pause-until:workable', '0', 1);
    const rr = await probeCompany(`blockedprovider co ${i}`);
    if (rr.inconclusive) sawInconclusiveEarly = true;
    else if (i > 0) reachedVerdictAfterDegrade = true;
  }
  check(
    'persistently blocked provider stops forcing inconclusive',
    sawInconclusiveEarly && reachedVerdictAfterDegrade,
    `inconclusive_seen=${sawInconclusiveEarly} verdict_after_degrade=${reachedVerdictAfterDegrade}`
  );

  console.log('\n' + results.join('\n'));
  const failed = results.filter(x => x.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed;
}

main()
  .then(async failed => {
    await clearCircuits(); // never leave a tripped circuit behind in shared redis
    process.exit(failed ? 1 : 0);
  })
  .catch(async e => { console.error(e); await clearCircuits(); process.exit(1); });
