import 'dotenv/config';
import postgres from 'postgres';
import { chromium, type Browser } from 'playwright';

/**
 * Bake-off: for the same 25 Adzuna jobs, which search engine returns the
 * company's homepage as the first organic result when queried "<company>, <city>"?
 *
 * Strategies under test:
 *   A) Bing HTML scrape      (bing.com/search)
 *   B) DuckDuckGo HTML scrape (html.duckduckgo.com/html)
 *   C) Playwright → Google   (headless Chrome, google.com/search)
 *
 * Per strategy, per job, record:
 *   - first_url: first non-aggregator organic result
 *   - token_match: company tokens appear in that URL's host or fetched <title>
 *   - latency_ms
 */

const AGGREGATOR_DOMAINS = [
  'adzuna', 'indeed', 'linkedin', 'glassdoor', 'ziprecruiter', 'monster',
  'simplyhired', 'careerbuilder', 'jobcase', 'jooble', 'dice', 'google.com',
  'bing.com', 'duckduckgo.com', 'yahoo.com', 'wikipedia', 'bloomberg',
  'craigslist', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
  'youtube.com', 'reddit.com', 'talent.com', 'snagajob', 'jobs2careers',
  'jobright', 'lensa', 'usajobs', 'builtin', 'salary.com', 'payscale',
  'trustpilot', 'bbb.org', 'yelp.com', 'greatschools', 'crunchbase',
  'bloomberg.com', 'mapquest', 'maps.google', 'yellowpages',
  'greenhouse.io', 'lever.co', 'myworkday', 'workday.com', 'smartrecruiters',
  'ashbyhq.com', 'jobvite', 'icims.com', 'successfactors', 'taleo.net',
  'bamboohr', 'recruitee.com', 'workable.com', 'breezy.hr',
];

const COMPANY_SUFFIXES = new Set([
  'inc', 'llc', 'corp', 'corporation', 'company', 'co', 'ltd', 'limited',
  'group', 'careers', 'usa', 'na', 'plc', 'holdings', 'international',
  'industries', 'enterprises', 'solutions', 'services', 'partners',
  'bank', 'center', 'systems', 'foundation', 'stores', 'development',
  'motors', 'technologies', 'consulting', 'associates', 'the', 'and',
]);

function looksLikeAggregator(url: string): boolean {
  const lower = url.toLowerCase();
  return AGGREGATOR_DOMAINS.some(d => lower.includes(`://${d}`) || lower.includes(`.${d}`) || lower.includes(`//${d}`));
}

function getHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function companyTokens(name: string): string[] {
  return name.toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !COMPANY_SUFFIXES.has(t));
}

function hostTokenMatch(host: string, tokens: string[]): boolean {
  if (!tokens.length) return false;
  const h = host.replace(/\.(com|net|org|io|co|us|ai|app)$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return tokens.some(t => h.includes(t));
}

function extractCity(location: string | null): string | null {
  if (!location) return null;
  const first = location.split(',')[0].trim();
  if (!first) return null;
  if (/^(remote|united states|us|usa|anywhere)$/i.test(first)) return null;
  return first;
}

async function fetchWithTimeout(url: string, ms: number, headers: Record<string, string>): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; } finally { clearTimeout(timer); }
}

// --- F) Clearbit Autocomplete (company-name → domain, no auth) ---
async function searchClearbit(companyName: string): Promise<string | null> {
  const url = `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(companyName)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: ctrl.signal });
    if (!r.ok) return null;
    const arr = await r.json() as Array<{ name: string; domain: string }>;
    const first = arr.find(x => x.domain && !looksLikeAggregator(`https://${x.domain}`));
    return first ? `https://${first.domain}` : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// --- E) Google Custom Search JSON API ---
async function searchGoogleCSE(query: string, apiKey: string, cx: string): Promise<string | null> {
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=10&gl=us`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: ctrl.signal });
    if (!r.ok) {
      const body = await r.text();
      console.log(`     cse HTTP ${r.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const json = await r.json() as { items?: Array<{ link: string }> };
    const items = json.items ?? [];
    for (const it of items) {
      if (it.link && it.link.startsWith('http') && !looksLikeAggregator(it.link)) return it.link;
    }
    return null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// --- D) Brave Search API ---
async function searchBrave(query: string, apiKey: string): Promise<string | null> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&country=US`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.log(`     brave HTTP ${r.status}`);
      return null;
    }
    const json = await r.json() as { web?: { results?: Array<{ url: string }> } };
    const results = json.web?.results ?? [];
    for (const res of results) {
      if (res.url && res.url.startsWith('http') && !looksLikeAggregator(res.url)) return res.url;
    }
    return null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// --- A) Bing HTML scrape ---
async function searchBing(query: string): Promise<string | null> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10`;
  const html = await fetchWithTimeout(url, 8000, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  });
  if (!html) return null;
  // Bing results: <li class="b_algo"> ... <h2><a href="...">
  const matches = Array.from(html.matchAll(/<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*>\s*<a\s+href="([^"]+)"/gi));
  for (const m of matches) {
    const href = m[1];
    if (href.startsWith('http') && !looksLikeAggregator(href)) return href;
  }
  return null;
}

// --- B) DuckDuckGo HTML scrape ---
async function searchDDG(query: string): Promise<string | null> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchWithTimeout(url, 8000, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://duckduckgo.com/',
  });
  if (!html || !html.includes('uddg=')) return null;
  const redirectMatches = Array.from(html.matchAll(/\/l\/\?(?:kh=-1&)?uddg=([^&"]+)/gi));
  for (const m of redirectMatches) {
    try {
      const decoded = decodeURIComponent(m[1]);
      if (!looksLikeAggregator(decoded)) return decoded;
    } catch { /* keep trying */ }
  }
  return null;
}

// --- C) Playwright → Google ---
async function searchGoogle(browser: Browser, query: string): Promise<string | null> {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us`, {
      waitUntil: 'domcontentloaded', timeout: 10000,
    });
    // Google organic result anchors: <a href="/url?q=..."> under #search or a[jsname]
    const urls = await page.$$eval('a', as => as.map(a => (a as HTMLAnchorElement).href).filter(Boolean));
    for (const u of urls) {
      if (!u.startsWith('http')) continue;
      if (looksLikeAggregator(u)) continue;
      if (u.includes('google.com/search') || u.includes('google.com/aclk')) continue;
      if (u.includes('accounts.google') || u.includes('support.google')) continue;
      if (u.includes('policies.google')) continue;
      return u;
    }
    return null;
  } catch { return null; } finally {
    await ctx.close();
  }
}

async function main() {
  const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL not set');
  const sql = postgres(url, { max: 1, prepare: false });

  // Deterministic sample — stable set across strategies & runs
  const rows = await sql<Array<{ id: number; company: string; location: string | null }>>`
    SELECT id, company, location
    FROM job_postings
    WHERE source = 'Adzuna' AND company IS NOT NULL AND company != ''
    ORDER BY id
    LIMIT 25
  `;
  await sql.end();

  console.log(`Sample: ${rows.length} Adzuna jobs (deterministic, ordered by id)\n`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH,
  });

  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!braveKey) console.log('⚠  BRAVE_SEARCH_API_KEY not set — skipping Brave.');
  const cseKey = process.env.GOOGLE_CSE_API_KEY;
  const cseId = process.env.GOOGLE_CSE_ID;
  if (!cseKey || !cseId) console.log('⚠  GOOGLE_CSE_API_KEY / GOOGLE_CSE_ID not set — skipping CSE.');
  console.log();

  type Result = { got: boolean; plausible: boolean; host: string; ms: number };
  const results: { clearbit: Result[]; cse: Result[]; brave: Result[]; bing: Result[]; ddg: Result[]; google: Result[] } =
    { clearbit: [], cse: [], brave: [], bing: [], ddg: [], google: [] };

  for (let i = 0; i < rows.length; i++) {
    const job = rows[i];
    const city = extractCity(job.location);
    const query = city ? `${job.company}, ${city}` : job.company;
    const tokens = companyTokens(job.company);

    console.log(`[${String(i + 1).padStart(2)}] ${job.company}  (${city ?? 'no-city'})`);
    console.log(`     query: "${query}"`);

    // F) Clearbit Autocomplete (company name only — city is ignored)
    {
      const ct = Date.now();
      const cbUrl = await searchClearbit(job.company);
      const cbMs = Date.now() - ct;
      const cbHost = cbUrl ? getHost(cbUrl) : '';
      const cbMatch = cbUrl != null && hostTokenMatch(cbHost, tokens);
      results.clearbit.push({ got: cbUrl != null, plausible: cbMatch, host: cbHost, ms: cbMs });
      console.log(`     cbit   ${cbMatch ? '✓' : (cbUrl ? '~' : '✗')}  ${cbHost || '-'}  (${cbMs}ms)`);
      await new Promise(r => setTimeout(r, 200));
    }

    // E) Google CSE (if keys present)
    if (cseKey && cseId) {
      const ct = Date.now();
      const cseUrl = await searchGoogleCSE(query, cseKey, cseId);
      const cseMs = Date.now() - ct;
      const cseHost = cseUrl ? getHost(cseUrl) : '';
      const cseMatch = cseUrl != null && !looksLikeAggregator(cseUrl) && hostTokenMatch(cseHost, tokens);
      results.cse.push({ got: cseUrl != null, plausible: cseMatch, host: cseHost, ms: cseMs });
      console.log(`     cse    ${cseMatch ? '✓' : (cseUrl ? '~' : '✗')}  ${cseHost || '-'}  (${cseMs}ms)`);
      await new Promise(r => setTimeout(r, 200));
    }

    // D) Brave (if key present)
    if (braveKey) {
      const bt = Date.now();
      const braveUrl = await searchBrave(query, braveKey);
      const braveMs = Date.now() - bt;
      const braveHost = braveUrl ? getHost(braveUrl) : '';
      const braveMatch = braveUrl != null && !looksLikeAggregator(braveUrl) && hostTokenMatch(braveHost, tokens);
      results.brave.push({ got: braveUrl != null, plausible: braveMatch, host: braveHost, ms: braveMs });
      console.log(`     brave  ${braveMatch ? '✓' : (braveUrl ? '~' : '✗')}  ${braveHost || '-'}  (${braveMs}ms)`);
      await new Promise(r => setTimeout(r, 1100)); // Brave free tier: 1 QPS
    }

    // A) Bing
    let t = Date.now();
    const bingUrl = await searchBing(query);
    let bingMs = Date.now() - t;
    const bingHost = bingUrl ? getHost(bingUrl) : '';
    const bingMatch = bingUrl != null && !looksLikeAggregator(bingUrl) && hostTokenMatch(bingHost, tokens);
    results.bing.push({ got: bingUrl != null, plausible: bingMatch, host: bingHost, ms: bingMs });
    console.log(`     bing   ${bingMatch ? '✓' : (bingUrl ? '~' : '✗')}  ${bingHost || '-'}  (${bingMs}ms)`);

    await new Promise(r => setTimeout(r, 500));

    // B) DDG
    t = Date.now();
    const ddgUrl = await searchDDG(query);
    let ddgMs = Date.now() - t;
    const ddgHost = ddgUrl ? getHost(ddgUrl) : '';
    const ddgMatch = ddgUrl != null && !looksLikeAggregator(ddgUrl) && hostTokenMatch(ddgHost, tokens);
    results.ddg.push({ got: ddgUrl != null, plausible: ddgMatch, host: ddgHost, ms: ddgMs });
    console.log(`     ddg    ${ddgMatch ? '✓' : (ddgUrl ? '~' : '✗')}  ${ddgHost || '-'}  (${ddgMs}ms)`);

    await new Promise(r => setTimeout(r, 800));

    // C) Google (playwright)
    t = Date.now();
    const gUrl = await searchGoogle(browser, query);
    let gMs = Date.now() - t;
    const gHost = gUrl ? getHost(gUrl) : '';
    const gMatch = gUrl != null && !looksLikeAggregator(gUrl) && hostTokenMatch(gHost, tokens);
    results.google.push({ got: gUrl != null, plausible: gMatch, host: gHost, ms: gMs });
    console.log(`     google ${gMatch ? '✓' : (gUrl ? '~' : '✗')}  ${gHost || '-'}  (${gMs}ms)`);

    await new Promise(r => setTimeout(r, 1000));
  }

  await browser.close();

  function summarize(name: string, rs: Result[]) {
    const n = rs.length;
    const got = rs.filter(r => r.got).length;
    const plaus = rs.filter(r => r.plausible).length;
    const avg = Math.round(rs.reduce((a, r) => a + r.ms, 0) / n);
    console.log(`${name.padEnd(8)}  got=${got}/${n}  tokenMatch=${plaus}/${n} (${((plaus/n)*100).toFixed(0)}%)  avgLatency=${avg}ms`);
  }

  console.log(`\n=== Summary ===`);
  summarize('clearbit', results.clearbit);
  if (cseKey && cseId) summarize('cse', results.cse);
  if (braveKey) summarize('brave', results.brave);
  summarize('bing', results.bing);
  summarize('ddg', results.ddg);
  summarize('google', results.google);
  console.log(`\nLegend: ✓ first result matches company tokens, ~ got a non-aggregator URL but tokens didn't match, ✗ no usable result.`);
}

main().catch(err => { console.error(err); process.exit(1); });
