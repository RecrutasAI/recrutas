/**
 * Adzuna Link Resolver
 *
 * Resolves Adzuna redirect_url → direct ATS job URL or company careers page.
 *
 * Resolution chain per job:
 *   1. DB discovered_companies (approved, with ATS) → ATS API → best title match
 *   2. COMPANY_CATALOG (hardcoded) → ATS API → best title match
 *   3. COMPANY_CATALOG careersUrl (staffing/healthcare/no-ATS companies)
 *   4. Clearbit autocomplete → domain validation
 *   5. Domain guess → HTML title validation
 *   6. URL extracted from job description text
 *   7. Fallback: original Adzuna redirect_url (resolved: false)
 */
import 'dotenv/config';
import postgres, { Sql } from 'postgres';

export type AtsType = 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'recruitee' | 'smartrecruiters' | 'breezy';

interface AtsJob {
  title: string;
  location?: string;
  url: string;
  description?: string;
}

/** Minimal HTML→text for ATS descriptions returned as HTML (greenhouse, recruitee). */
function stripHtml(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

interface CompanyInfo {
  atsType: AtsType | null;
  atsId: string | null;
  jobs: AtsJob[];
  expires: number;
}

// ─── constants ───────────────────────────────────────────────────────────────

const CACHE_TTL_MS          = 30 * 60 * 1000;
const NEG_CACHE_TTL_MS      = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS      = 6_000;
const MATCH_THRESHOLD       = 0.35;
const HOMEPAGE_POS_TTL_MS   = 24 * 60 * 60 * 1000;
const HOMEPAGE_NEG_TTL_MS   = 60 * 60 * 1000;
const APPROVED_TTL_MS       = 10 * 60 * 1000;

// ─── in-memory caches ─────────────────────────────────────────────────────────

const companyCache    = new Map<string, CompanyInfo>();
const inflight        = new Map<string, Promise<CompanyInfo>>();
const homepageCache   = new Map<string, { url: string | null; expires: number }>();
const homepageInflight = new Map<string, Promise<string | null>>();

// ─── unified company catalog ──────────────────────────────────────────────────
// All keys: lowercase, alphanumeric only (same output as normalizeCompanyName).
// Priority: DB discovered_companies > this catalog.
// Use atsType+atsId for companies with public ATS APIs.
// Use careersUrl for companies where we know the careers page but not the ATS.

interface CatalogEntry {
  atsType?: AtsType;
  atsId?:   string;
  careersUrl?: string;
}

const COMPANY_CATALOG: Record<string, CatalogEntry> = {
  // ── Big tech — custom ATS (not Greenhouse) ────────────────────────────────
  google:           { careersUrl: 'https://careers.google.com/' },
  meta:             { careersUrl: 'https://www.metacareers.com/' },
  facebook:         { careersUrl: 'https://www.metacareers.com/' },
  amazon:           { careersUrl: 'https://www.amazon.jobs/' },
  apple:            { careersUrl: 'https://jobs.apple.com/' },
  microsoft:        { careersUrl: 'https://careers.microsoft.com/' },
  netflix:          { careersUrl: 'https://jobs.netflix.com/' },
  linkedin:         { careersUrl: 'https://careers.linkedin.com/' },
  salesforce:       { careersUrl: 'https://careers.salesforce.com/' },
  shopify:          { careersUrl: 'https://www.shopify.com/careers' },
  ibm:              { careersUrl: 'https://www.ibm.com/employment/' },
  oracle:           { careersUrl: 'https://www.oracle.com/careers/' },
  cisco:            { careersUrl: 'https://jobs.cisco.com/' },
  intuit:           { careersUrl: 'https://careers.intuit.com/' },
  nvidia:           { careersUrl: 'https://www.nvidia.com/en-us/about-nvidia/careers/' },
  adobe:            { careersUrl: 'https://www.adobe.com/careers.html' },
  // ── Big tech — confirmed Greenhouse ──────────────────────────────────────
  stripe:           { atsType: 'greenhouse', atsId: 'stripe' },
  uber:             { atsType: 'greenhouse', atsId: 'uber' },
  airbnb:           { atsType: 'greenhouse', atsId: 'airbnb' },
  dropbox:          { atsType: 'greenhouse', atsId: 'dropbox' },
  coinbase:         { atsType: 'greenhouse', atsId: 'coinbase' },
  spotify:          { atsType: 'greenhouse', atsId: 'spotify' },
  figma:            { atsType: 'greenhouse', atsId: 'figma' },
  twilio:           { atsType: 'greenhouse', atsId: 'twilio' },
  datadog:          { atsType: 'greenhouse', atsId: 'datadog' },
  snowflake:        { atsType: 'greenhouse', atsId: 'snowflake' },
  mongodb:          { atsType: 'greenhouse', atsId: 'mongodb' },
  tesla:            { atsType: 'greenhouse', atsId: 'tesla' },
  autodesk:         { atsType: 'greenhouse', atsId: 'autodesk' },
  snap:             { atsType: 'greenhouse', atsId: 'snap' },
  pinterest:        { atsType: 'greenhouse', atsId: 'pinterest' },
  robinhood:        { atsType: 'greenhouse', atsId: 'robinhood' },
  squarespace:      { atsType: 'greenhouse', atsId: 'squarespace' },
  cloudflare:       { atsType: 'lever',      atsId: 'cloudflare' },
  lyft:             { atsType: 'lever',      atsId: 'lyft' },
  notion:           { atsType: 'lever',      atsId: 'notion' },
  doordash:         { atsType: 'lever',      atsId: 'doordash' },
  instacart:        { atsType: 'lever',      atsId: 'instacart' },
  atlassian:        { atsType: 'lever',      atsId: 'atlassian' },
  // ── Defense — custom ATS ──────────────────────────────────────────────────
  lockheedmartin:   { careersUrl: 'https://www.lockheedmartin.com/en-us/careers.html' },
  northropgrumman:  { careersUrl: 'https://www.northropgrumman.com/careers/' },
  raytheon:         { careersUrl: 'https://jobs.rtx.com/' },
  boeing:           { careersUrl: 'https://jobs.boeing.com/' },
  leidos:           { careersUrl: 'https://careers.leidos.com/' },
  boozallenhamilton:{ careersUrl: 'https://www.boozallen.com/careers.html' },
  generaldynamics:  { careersUrl: 'https://jobs.gd.com/' },
  baesystems:       { careersUrl: 'https://jobs.baesystems.com/' },
  l3harris:         { atsType: 'workable',   atsId: 'l3harris' },
  generalatomics:   { atsType: 'greenhouse', atsId: 'generalatomics' },
  // ── Finance — custom ATS ─────────────────────────────────────────────────
  capitalone:       { careersUrl: 'https://www.capitalonecareers.com/' },
  bankofamerica:    { careersUrl: 'https://careers.bankofamerica.com/' },
  jpmorgan:         { careersUrl: 'https://careers.jpmorgan.com/' },
  goldmansachs:     { careersUrl: 'https://www.goldmansachs.com/careers/' },
  wellsfargo:       { careersUrl: 'https://www.wellsfargojobs.com/' },
  citi:             { careersUrl: 'https://jobs.citi.com/' },
  hsbc:             { careersUrl: 'https://www.hsbc.com/careers' },
  // ── Consulting ────────────────────────────────────────────────────────────
  accenture:        { careersUrl: 'https://www.accenture.com/us-en/careers' },
  deloitte:         { careersUrl: 'https://jobs2.deloitte.com/' },
  pwc:              { careersUrl: 'https://www.pwc.com/us/en/careers.html' },
  kpmg:             { careersUrl: 'https://jobs.kpmg.us/' },
  ey:               { careersUrl: 'https://careers.ey.com/' },
  mckinsey:         { careersUrl: 'https://www.mckinsey.com/careers' },
  bain:             { careersUrl: 'https://www.bain.com/careers' },
  bcg:              { careersUrl: 'https://www.bcg.com/careers' },
  boostonconsultinggroup: { careersUrl: 'https://www.bcg.com/careers' },
  cognizant:        { careersUrl: 'https://careers.cognizant.com' },
  infosys:          { careersUrl: 'https://www.infosys.com/careers' },
  tcs:              { careersUrl: 'https://www.tcs.com/careers' },
  wipro:            { careersUrl: 'https://careers.wipro.com' },
  capgemini:        { careersUrl: 'https://www.capgemini.com/careers' },
  mindbank:         { careersUrl: 'https://mindbank.com/careers' },
  mindbankconsulting:{ careersUrl: 'https://mindbank.com/careers' },
  bakertilly:       { careersUrl: 'https://www.bakertilly.com/careers' },
  boozallen:        { careersUrl: 'https://www.boozallen.com/careers' },
  // ── Retail — custom ATS ───────────────────────────────────────────────────
  disney:           { careersUrl: 'https://jobs.disneycareers.com/' },
  walmart:          { careersUrl: 'https://careers.walmart.com/' },
  target:           { careersUrl: 'https://jobs.target.com/' },
  bestbuy:          { careersUrl: 'https://jobs.bestbuy.com/' },
  homedepot:        { careersUrl: 'https://careers.homedepot.com/' },
  lowes:            { careersUrl: 'https://jobs.lowes.com/' },
  hollister:        { careersUrl: 'https://www.hollisterco.com/careers' },
  // ── Healthcare / insurance — custom ATS ──────────────────────────────────
  unitedhealthgroup:{ careersUrl: 'https://careers.unitedhealthgroup.com/' },
  cigna:            { careersUrl: 'https://jobs.cigna.com/' },
  humana:           { careersUrl: 'https://careers.humana.com/' },
  hcahealthcare:    { careersUrl: 'https://careers.hcahealthcare.com/' },
  clevelandclinic:  { careersUrl: 'https://jobs.clevelandclinic.org/' },
  optum:            { careersUrl: 'https://careers.optum.com' },
  unitedhealth:     { careersUrl: 'https://www.unitedhealthgroup.com/careers' },
  anthem:           { careersUrl: 'https://www.anthem.com/careers' },
  bluecross:        { careersUrl: 'https://www.bluecrossma.com/careers' },
  aetna:            { careersUrl: 'https://www.aetna.com/careers' },
  cvs:              { careersUrl: 'https://jobs.cvshealth.com' },
  cvshealth:        { careersUrl: 'https://jobs.cvshealth.com' },
  walgreens:        { careersUrl: 'https://jobs.walgreens.com' },
  questdiagnostics: { careersUrl: 'https://www.questdiagnostics.com/careers' },
  quest:            { careersUrl: 'https://www.questdiagnostics.com/careers' },
  labcorp:          { careersUrl: 'https://careers.labcorp.com' },
  christushealth:   { careersUrl: 'https://careers.christushealth.org' },
  commonspirit:     { careersUrl: 'https://www.commonspirit.org/careers' },
  providence:       { careersUrl: 'https://www.providence.org/careers' },
  centura:          { careersUrl: 'https://www.centura.org/careers' },
  sutter:           { careersUrl: 'https://jobs.sutterhealth.org' },
  kaiser:           { careersUrl: 'https://healthy.kaiserpermanente.org/careers' },
  kaiserpermanente: { careersUrl: 'https://healthy.kaiserpermanente.org/careers' },
  intermountain:    { careersUrl: 'https://intermountainhealthcare.org/careers' },
  ascension:        { careersUrl: 'https://careers.ascension.org' },
  trinity:          { careersUrl: 'https://www.trinity-health.org/careers' },
  adventist:        { careersUrl: 'https://www.adventisthealth.org/careers' },
  adventisthealth:  { careersUrl: 'https://www.adventisthealth.org/careers' },
  mercy:            { careersUrl: 'https://www.mercy.net/careers' },
  hca:              { careersUrl: 'https://www.hcacareers.com' },
  tenet:            { careersUrl: 'https://www.tenethealth.com/careers' },
  universalhealth:  { careersUrl: 'https://www.uhc.com/careers' },
  takeda:           { careersUrl: 'https://www.takeda.com/careers' },
  memorialhermann:  { careersUrl: 'https://careers.memorialhermann.org' },
  wellstar:         { careersUrl: 'https://www.wellstar.org/careers' },
  northwell:        { careersUrl: 'https://www.northwell.edu/careers' },
  uclahealth:       { careersUrl: 'https://jobs.uclahealth.org' },
  cedarssinai:      { careersUrl: 'https://www.cedars-sinai.org/careers' },
  houstonmethodist: { careersUrl: 'https://www.houstonmethodist.org/careers' },
  dukehealth:       { careersUrl: 'https://jobs.dukehealth.org' },
  duke:             { careersUrl: 'https://jobs.dukehealth.org' },
  wakehealth:       { careersUrl: 'https://www.wakehealth.edu/careers' },
  newyorkpresbyterian:{ careersUrl: 'https://careers.nyp.org' },
  nypresbyterian:   { careersUrl: 'https://careers.nyp.org' },
  aspendental:      { careersUrl: 'https://www.aspendental.com/careers' },
  advocate:         { careersUrl: 'https://www.advocatehealth.com/careers' },
  stlukes:          { careersUrl: 'https://www.slhn.org/careers' },
  stluke:           { careersUrl: 'https://www.slhn.org/careers' },
  primehealthcare:  { careersUrl: 'https://www.primehealthcare.com/careers' },
  prime:            { careersUrl: 'https://www.primehealthcare.com/careers' },
  cogir:            { careersUrl: 'https://www.cogircareers.com' },
  // ── Staffing ──────────────────────────────────────────────────────────────
  teksystems:       { careersUrl: 'https://www.teksystems.com/careers' },
  allegisgroup:     { careersUrl: 'https://www.allegisgroup.com/careers' },
  roberthalf:       { careersUrl: 'https://www.roberthalf.com/careers' },
  randstad:         { careersUrl: 'https://www.randstadusa.com/careers' },
  amnhealthcare:    { careersUrl: 'https://www.amnhealthcare.com/careers' },
  fusionmedical:    { careersUrl: 'https://www.fusionmedstaffing.com/careers' },
  fusionmedicalstaffing: { careersUrl: 'https://www.fusionmedstaffing.com/careers' },
  yearup:           { careersUrl: 'https://www.yearup.org/careers' },
  yearupunited:     { careersUrl: 'https://www.yearup.org/careers' },
  triage:           { careersUrl: 'https://www.triagestaff.com/careers' },
  triagestaff:      { careersUrl: 'https://www.triagestaff.com/careers' },
  vaco:             { careersUrl: 'https://www.vaco.com/careers' },
  highspring:       { careersUrl: 'https://www.vaco.com/careers' },
  prosidian:        { careersUrl: 'https://www.prosidianconsulting.com/careers' },
};

// ─── company name normalization ───────────────────────────────────────────────

function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// ─── ATS API clients ──────────────────────────────────────────────────────────

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'RecrutasJobAggregator/1.0', Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function listAtsJobs(atsType: AtsType, atsId: string): Promise<AtsJob[]> {
  try {
    if (atsType === 'greenhouse') {
      // ?content=true returns the full posting body in the same list call.
      const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${atsId}/jobs?content=true`) as
        | { jobs?: Array<{ title: string; location?: { name?: string }; absolute_url?: string; content?: string }> }
        | null;
      return (data?.jobs ?? [])
        .map(j => ({ title: j.title, location: j.location?.name, url: j.absolute_url ?? '', description: stripHtml(j.content) }))
        .filter(j => j.title && j.url);
    }
    if (atsType === 'lever') {
      const data = await fetchJson(`https://api.lever.co/v0/postings/${atsId}?mode=json`) as
        | Array<{ text: string; categories?: { location?: string }; hostedUrl?: string; descriptionPlain?: string }>
        | null;
      return (Array.isArray(data) ? data : [])
        .map(j => ({ title: j.text, location: j.categories?.location, url: j.hostedUrl ?? '', description: j.descriptionPlain ?? '' }))
        .filter(j => j.title && j.url);
    }
    if (atsType === 'ashby') {
      const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${atsId}`) as
        | { jobs?: Array<{ title: string; locationName?: string; jobUrl?: string; descriptionPlain?: string }> }
        | null;
      return (data?.jobs ?? [])
        .map(j => ({ title: j.title, location: j.locationName, url: j.jobUrl ?? '', description: j.descriptionPlain ?? '' }))
        .filter(j => j.title && j.url);
    }
    if (atsType === 'workable') {
      // Workable's public widget endpoint returns the account doc with a
      // `jobs` array. The previously-used `/vacancies/` path 404s. The job
      // `url` field already points to apply.workable.com/j/<shortcode>; no
      // reconstruction needed.
      // TODO: this list endpoint does not include the job description; jobs
      // ingested from workable remain description-less (no skill extraction)
      // until we add a per-posting detail fetch. ~4% of ATS supply.
      const data = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${atsId}`) as
        | { jobs?: Array<{ title?: string; city?: string; state?: string; country?: string; url?: string }> }
        | null;
      return (data?.jobs ?? [])
        .map(j => ({
          title: j.title ?? '',
          location: [j.city, j.state, j.country].filter(Boolean).join(', ') || undefined,
          url: j.url ?? '',
        }))
        .filter(j => j.title && j.url);
    }
    if (atsType === 'recruitee') {
      const data = await fetchJson(`https://${atsId}.recruitee.com/api/offers`) as
        | { offers?: Array<{ title: string; city?: string; country?: string; slug?: string; description?: string }> }
        | null;
      return (data?.offers ?? [])
        .map(j => ({
          title: j.title,
          location: j.city ?? j.country,
          url: j.slug ? `https://${atsId}.recruitee.com/o/${j.slug}` : '',
          description: stripHtml(j.description),
        }))
        .filter(j => j.title && j.url);
    }
    if (atsType === 'smartrecruiters') {
      // Public postings list. The list omits the body, so jobs are
      // description-less (same as workable) until a per-posting detail fetch is
      // added. Public job URL: jobs.smartrecruiters.com/<identifier>/<postingId>.
      const data = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${atsId}/postings?limit=100`) as
        | { content?: Array<{ id: string; name: string; location?: { city?: string; region?: string; country?: string; fullLocation?: string } }> }
        | null;
      return (data?.content ?? [])
        .map(j => ({
          title: j.name,
          location: j.location?.fullLocation
            || [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(', ')
            || undefined,
          url: j.id ? `https://jobs.smartrecruiters.com/${atsId}/${j.id}` : '',
        }))
        .filter(j => j.title && j.url);
    }
    if (atsType === 'breezy') {
      // Public board JSON; each item carries a direct `url`. Description requires
      // a per-posting detail call, so list jobs are description-less.
      const data = await fetchJson(`https://${atsId}.breezy.hr/json`) as
        | Array<{ name: string; url?: string; location?: { city?: string; country?: { name?: string } } }>
        | null;
      return (Array.isArray(data) ? data : [])
        .map(j => ({
          title: j.name,
          location: [j.location?.city, j.location?.country?.name].filter(Boolean).join(', ') || undefined,
          url: j.url ?? '',
        }))
        .filter(j => j.title && j.url);
    }
  } catch { /* fall through */ }
  return [];
}

// ─── title / location matching ────────────────────────────────────────────────

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s+#]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOPWORDS = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'to', 'for', 'with', 'at', 'in']);

function tokenize(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(t => t.length > 0 && !STOPWORDS.has(t)));
}

function titleScore(target: string, candidate: string): number {
  const nt = normalizeTitle(target);
  const nc = normalizeTitle(candidate);
  if (nt === nc) return 1.0;

  const tt = tokenize(nt);
  const ct = tokenize(nc);
  if (tt.size === 0 || ct.size === 0) return 0;

  let inter = 0;
  for (const x of tt) {
    if (ct.has(x)) {
      inter++;
    } else {
      for (const y of ct) {
        if (x.includes(y) || y.includes(x)) { inter += 0.5; break; }
      }
    }
  }
  const union = tt.size + ct.size - inter;
  return union > 0 ? inter / union : 0;
}

function locationOverlap(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ta = tokenize(normalizeTitle(a));
  const tb = tokenize(normalizeTitle(b));
  for (const x of ta) if (tb.has(x) && x.length >= 3) return true;
  return false;
}

// Levenshtein distance for fuzzy title matching
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const min = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = row[j];
      row[j] = min;
    }
  }
  return row[b.length];
}

function fuzzyTitleScore(target: string, candidate: string): number {
  const nt = normalizeTitle(target);
  const nc = normalizeTitle(candidate);
  if (nt === nc) return 1.0;
  const maxLen = Math.max(nt.length, nc.length);
  if (maxLen === 0) return 0;
  const dist = levenshtein(nt, nc);
  return Math.max(0, 1 - dist / maxLen);
}

function pickBestMatch<T extends { title: string; url: string; location?: string }>(
  target: { title: string; location?: string },
  candidates: T[],
): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  for (const c of candidates) {
    let score = titleScore(target.title, c.title);
    const fuzzy = fuzzyTitleScore(target.title, c.title);
    score = Math.max(score, fuzzy * 0.8);
    if (target.location && c.location) {
      // soft penalty for known mismatch — half the bonus, so it only matters near the threshold
      if (locationOverlap(target.location, c.location)) score += 0.1;
      else score -= 0.05;
    }
    if (!best || score > best.score) best = { item: c, score };
  }
  return best;
}

// ─── homepage resolver ────────────────────────────────────────────────────────

const AGGREGATOR_DOMAINS = new Set([
  'adzuna','indeed','linkedin','glassdoor','ziprecruiter','monster',
  'simplyhired','careerbuilder','jobcase','jooble','dice','google',
  'bing','duckduckgo','yahoo','wikipedia','bloomberg','craigslist',
  'facebook','twitter','instagram','youtube','reddit','talent',
  'snagajob','jobs2careers','jobright','lensa','usajobs','builtin',
  'greenhouse','lever','myworkday','workday','smartrecruiters',
  'ashbyhq','jobvite','icims','successfactors','taleo','bamboohr',
  'recruitee','workable','breezy','veterans',
  // Extended job boards
  'themuse','weworkremotely','jobget','jobleads','applytojob','hosa',
  'careerjet','careerbliss','idealist','cybercoders',
  'jobdiagnosis','recruitifi','higheredjobs','healthcare',
  'medicists','healthjob','nurserecruiter','mdjobs','doccafe',
  'jobilero','workopolis','careercast','careerfocus',
]);

function isAggregatorDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '').split('.')[0];
  return AGGREGATOR_DOMAINS.has(d);
}

const COMPANY_SUFFIX_TOKENS = new Set([
  'inc','llc','corp','corporation','company','co','ltd','limited',
  'group','careers','usa','na','plc','holdings','international',
  'industries','enterprises','solutions','services','partners',
  'bank','center','systems','foundation','stores','development',
  'motors','technologies','consulting','associates',
]);

const HOMEPAGE_STOPWORDS = new Set(['and','or','the','a','an','of','for','with']);

function homepageTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t.length >= 2 && !HOMEPAGE_STOPWORDS.has(t) && !COMPANY_SUFFIX_TOKENS.has(t));
}

function domainStemMatchesTokens(domain: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const stem = domain
    .replace(/\.(com|net|org|io|co|us|ai|app|tech|info|biz)$/i, '')
    .replace(/\.co\.uk$/i, '')
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
  for (const t of tokens) {
    if (t.length >= 3 && stem.includes(t)) return true;
  }
  if (tokens.length >= 2) {
    const acronym = tokens.map(w => w[0]).join('');
    if (acronym.length >= 2 && stem.startsWith(acronym)) return true;
  }
  return false;
}

function domainCandidates(companyName: string): string[] {
  const tokens = homepageTokens(companyName);
  if (tokens.length === 0) return [];
  const set = new Set<string>();
  if (tokens[0]?.length >= 3) set.add(tokens[0]);
  set.add(tokens.join(''));
  set.add(tokens.join('-'));
  if (tokens.length >= 3) {
    const acronym = tokens.map(w => w[0]).join('');
    if (acronym.length >= 3 && acronym.length <= 8) set.add(acronym);
  }
  return [...set].filter(d => d.length >= 3 && d.length <= 40);
}

async function fetchHtml(url: string, timeoutMs = 5_000): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function extractPageTitle(html: string): string {
  const t   = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? '';
  const og  = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? '';
  return `${t} ${og}`.toLowerCase();
}

function pageTitleValidates(tokens: string[], pageTitle: string): boolean {
  if (!pageTitle || tokens.length === 0) return false;
  const pt = new Set(pageTitle.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
  let hits = 0;
  for (const t of tokens) if (pt.has(t)) hits++;
  if (tokens.length === 1) return hits === 1;
  if (tokens.length === 2) return hits === 2;
  return hits / tokens.length >= 0.67;
}

async function resolveHomepageUncached(companyName: string): Promise<string | null> {
  const cleaned = companyName
    .trim()
    .replace(/^\d{4,}\s+/, '')
    .replace(/\s+d\/?b\/?a\s+.*$/i, '')
    .replace(/\s+c\/o\s+.*$/i, '')
    .replace(/[\s–-]+(current\s+openings?|job\s+openings?|now\s+hiring|openings?|careers?|jobs?)[\s–-]*$/i, '')
    .trim();
  if (!cleaned) return null;

  const tokens = homepageTokens(cleaned);

  // 1. Clearbit autocomplete — single fast call before any HTTP probing
  try {
    const url = `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(cleaned)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      if (r.ok) {
        const arr = await r.json() as Array<{ name: string; domain: string }>;
        for (const hit of (arr ?? []).slice(0, 5)) {
          if (!isAggregatorDomain(hit.domain) && domainStemMatchesTokens(hit.domain, tokens)) {
            return `https://${hit.domain}`;
          }
        }
      }
    } finally { clearTimeout(timer); }
  } catch { /* fall through */ }

  // 2. Domain-guess fallback — only runs if Clearbit missed.
  // Build all candidate URLs, fire fetches in parallel, return first valid in priority order.
  const tlds = ['.com', '.io', '.ai', '.co', '.net'];
  const candidates: string[] = [];
  for (const cand of domainCandidates(cleaned)) {
    for (const tld of tlds) {
      for (const prefix of ['https://www.', 'https://']) {
        if (prefix === 'https://www.' && (tld === '.ai' || tld === '.io')) continue;
        candidates.push(`${prefix}${cand}${tld}`);
      }
    }
  }
  const settled = await Promise.all(
    candidates.map(async url => {
      const html = await fetchHtml(url);
      return html && pageTitleValidates(tokens, extractPageTitle(html)) ? url : null;
    }),
  );
  const found = settled.find((u): u is string => u !== null);
  if (found) return found;

  return null;
}

export async function resolveHomepage(companyName: string): Promise<string | null> {
  const key = normalizeCompanyName(companyName);
  if (!key) return null;
  const now = Date.now();
  const cached = homepageCache.get(key);
  if (cached && cached.expires > now) return cached.url;
  const existing = homepageInflight.get(key);
  if (existing) return existing;
  const p = resolveHomepageUncached(companyName)
    .then(url => {
      homepageCache.set(key, { url, expires: now + (url ? HOMEPAGE_POS_TTL_MS : HOMEPAGE_NEG_TTL_MS) });
      homepageInflight.delete(key);
      return url;
    })
    .catch(() => {
      homepageInflight.delete(key);
      return null;
    });
  homepageInflight.set(key, p);
  return p;
}

// ─── DB: discovered_companies ─────────────────────────────────────────────────
// One persistent connection shared across all refreshes.

let _sql: Sql | null = null;
function getDb(): Sql | null {
  const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!url) return null;
  if (!_sql) _sql = postgres(url, { max: 1, prepare: false, idle_timeout: 20 });
  return _sql;
}

let approvedMap: Map<string, CatalogEntry> | null = null;
let approvedLoadedAt = 0;

async function loadApprovedCompanies(): Promise<Map<string, CatalogEntry>> {
  const now = Date.now();
  if (approvedMap && now - approvedLoadedAt < APPROVED_TTL_MS) return approvedMap;

  const sql = getDb();
  if (!sql) {
    approvedMap = new Map();
    approvedLoadedAt = now;
    return approvedMap;
  }

  const rows = await sql<Array<{ normalizedName: string; detectedAts: string; atsId: string }>>`
    SELECT "normalizedName", "detectedAts", "atsId"
    FROM discovered_companies
    WHERE status = 'approved'
      AND "detectedAts" IS NOT NULL
      AND "atsId"        IS NOT NULL
  `;

  const allowed = new Set<AtsType>(['greenhouse', 'lever', 'ashby', 'workable', 'recruitee']);
  const map = new Map<string, CatalogEntry>();
  for (const r of rows) {
    if (!allowed.has(r.detectedAts as AtsType)) continue;
    const key = normalizeCompanyName(r.normalizedName);
    if (key) map.set(key, { atsType: r.detectedAts as AtsType, atsId: r.atsId });
  }
  approvedMap = map;
  approvedLoadedAt = now;
  return map;
}

async function lookupCatalogEntry(companyName: string): Promise<CatalogEntry | null> {
  const key = normalizeCompanyName(companyName);
  if (!key) return null;

  // DB takes priority over static catalog
  const approved = await loadApprovedCompanies().catch(() => new Map<string, CatalogEntry>());
  const dbHit = approved.get(key);
  if (dbHit) return dbHit;

  return COMPANY_CATALOG[key] ?? null;
}

// ─── company-level ATS cache ──────────────────────────────────────────────────

async function loadCompany(companyName: string): Promise<CompanyInfo> {
  const entry = await lookupCatalogEntry(companyName);

  if (!entry?.atsType || !entry?.atsId) {
    return { atsType: null, atsId: null, jobs: [], expires: Date.now() + NEG_CACHE_TTL_MS };
  }

  const jobs = await listAtsJobs(entry.atsType, entry.atsId);
  return { atsType: entry.atsType, atsId: entry.atsId, jobs, expires: Date.now() + CACHE_TTL_MS };
}

async function getCompanyCached(companyName: string): Promise<CompanyInfo> {
  const key = normalizeCompanyName(companyName);
  const now = Date.now();
  const cached = companyCache.get(key);
  if (cached && cached.expires > now) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = loadCompany(companyName)
    .then(entry => { companyCache.set(key, entry); inflight.delete(key); return entry; })
    .catch(() => { inflight.delete(key); return { atsType: null, atsId: null, jobs: [], expires: Date.now() + NEG_CACHE_TTL_MS }; });
  inflight.set(key, p);
  return p;
}

// ─── ATS embed detection from careers page HTML ───────────────────────────────

interface EmbedDetection {
  atsType: AtsType;
  atsId:   string;
}

export interface CareersPageAnalysis {
  embed:      EmbedDetection | null;
  jsonLdJobs: Array<{ title: string; url: string }>;
}

const EMBED_PATTERNS: Array<{ atsType: AtsType; re: RegExp }> = [
  { atsType: 'greenhouse', re: /boards\.greenhouse\.io\/embed\/job_board\/js\?for=([\w-]+)/i },
  { atsType: 'greenhouse', re: /boards\.greenhouse\.io\/([\w-]+)(?:\/|"|'|\s)/i },
  { atsType: 'lever',      re: /jobs\.lever\.co\/([\w-]+)(?:\/|"|'|\s)/i },
  { atsType: 'ashby',      re: /jobs\.ashbyhq\.com\/([\w-]+)(?:\/|"|'|\s)/i },
  { atsType: 'ashby',      re: /([\w-]+)\.ashbyhq\.com(?:\/|"|'|\s)/i },
  { atsType: 'workable',   re: /apply\.workable\.com\/([\w-]+)(?:\/|"|'|\s)/i },
  { atsType: 'recruitee',  re: /(?:https?:\/\/)?([\w-]+)\.recruitee\.com(?:\/|"|'|\s)/i },
];

function analyzeHtml(html: string): CareersPageAnalysis {
  // ATS embed signatures
  let embed: EmbedDetection | null = null;
  for (const { atsType, re } of EMBED_PATTERNS) {
    const m = html.match(re);
    if (m?.[1] && m[1].length >= 2 && m[1].length <= 60) {
      embed = { atsType, atsId: m[1] };
      break;
    }
  }

  // JSON-LD JobPosting blocks
  const jsonLdJobs: Array<{ title: string; url: string }> = [];
  for (const block of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data: unknown = JSON.parse(block[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items as Record<string, unknown>[]) {
        if (item['@type'] !== 'JobPosting') continue;
        const url = (item['url'] ?? item['sameAs']) as string | undefined;
        const title = (item['title'] as string | undefined) ?? '';
        if (url && title && !AGGREGATOR_PATTERN.test(url)) jsonLdJobs.push({ title, url });
      }
    } catch { /* malformed JSON-LD */ }
  }

  return { embed, jsonLdJobs };
}

const careersCache    = new Map<string, { analysis: CareersPageAnalysis | null; expires: number }>();
const careersInflight = new Map<string, Promise<CareersPageAnalysis | null>>();

async function analyzeCareersPageUncached(homepage: string): Promise<CareersPageAnalysis | null> {
  const base = homepage.replace(/\/$/, '');
  // Only fetch /careers — 3s timeout to stay within batch budget
  const html = await fetchHtml(`${base}/careers`, 3_000);
  if (!html) return null;
  return analyzeHtml(html);
}

export async function analyzeCareersPage(homepage: string): Promise<CareersPageAnalysis | null> {
  const key = homepage.replace(/\/$/, '').toLowerCase();
  const now = Date.now();
  const cached = careersCache.get(key);
  if (cached && cached.expires > now) return cached.analysis;
  const existing = careersInflight.get(key);
  if (existing) return existing;
  const p = analyzeCareersPageUncached(homepage)
    .then(analysis => {
      const hasSignal = analysis?.embed || (analysis?.jsonLdJobs.length ?? 0) > 0;
      careersCache.set(key, { analysis, expires: now + (hasSignal ? CACHE_TTL_MS : NEG_CACHE_TTL_MS) });
      careersInflight.delete(key);
      return analysis;
    })
    .catch(() => { careersInflight.delete(key); return null; });
  careersInflight.set(key, p);
  return p;
}

// ─── URL extraction from description text ────────────────────────────────────

const AGGREGATOR_PATTERN = /adzuna|indeed|linkedin|glassdoor|ziprecruiter|monster|simplyhired|careerjet|themuse|weworkremotely|jobget|jobleads|applytojob|hosa/i;

// Specific ATS deep-link patterns — highest priority, return atsType for trust scoring
const ATS_SPECIFIC_PATTERNS: Array<{ atsType: AtsType; re: RegExp }> = [
  { atsType: 'greenhouse', re: /https?:\/\/boards\.greenhouse\.io\/[\w-]+\/jobs\/\d+(?:[?#][^\s<>"]*)?/i },
  { atsType: 'greenhouse', re: /https?:\/\/[\w-]+\.greenhouse\.io\/[\w/-]+(?:[?#][^\s<>"]*)?/i },
  { atsType: 'lever',      re: /https?:\/\/jobs\.(?:eu\.)?lever\.co\/[\w-]+\/[\w-]+(?:[?#][^\s<>"]*)?/i },
  { atsType: 'ashby',      re: /https?:\/\/jobs\.ashbyhq\.com\/[\w-]+(?:\/[\w-]+)?(?:[?#][^\s<>"]*)?/i },
  { atsType: 'ashby',      re: /https?:\/\/[\w-]+\.ashbyhq\.com\/[\w/-]*(?:[?#][^\s<>"]*)?/i },
  { atsType: 'workable',   re: /https?:\/\/apply\.workable\.com\/[\w-]+\/j\/\w+(?:[?#][^\s<>"]*)?/i },
  { atsType: 'recruitee',  re: /https?:\/\/[\w-]+\.recruitee\.com\/o\/[\w-]+(?:[?#][^\s<>"]*)?/i },
];

// Non-API ATS patterns — we can link directly but can't match by title
const ATS_GENERIC_PATTERNS: Array<RegExp> = [
  /https?:\/\/[\w-]+\.(?:wd\d+\.)?myworkdayjobs\.com\/[\w/-]+(?:[?#][^\s<>"]*)?/i,
  /https?:\/\/jobs\.smartrecruiters\.com\/[\w-]+(?:\/\d+)?(?:[?#][^\s<>"]*)?/i,
  /https?:\/\/[\w-]+\.bamboohr\.com\/(?:careers|jobs)\/\d+(?:[?#][^\s<>"]*)?/i,
  /https?:\/\/careers-[\w-]+\.icims\.com\/[\w/-]+(?:[?#][^\s<>"]*)?/i,
  /https?:\/\/jobs\.jobvite\.com\/[\w-]+\/job\/\w+(?:[?#][^\s<>"]*)?/i,
  // Oracle Taleo
  /https?:\/\/[\w-]+\.taleo\.net\/[\w-]+(?:\/\d+)?/i,
  /https?:\/\/taleo\.[\w-]+\.com\/[\w-]+/i,
  // Phenom People (now Hiring)
  /https?:\/\/[\w-]+\.phenompeople\.com\/[\w-]+/i,
  /https?:\/\/[\w-]+\.hirevue\.com\/[\w-]+/i,
  // UKG / UltiPro
  /https?:\/\/recruiting\.ultipro\.com\/[\w-]+/i,
  /https?:\/\/[\w-]+\.ultipro\.com\/[\w-]+/i,
  // Avature
  /https?:\/\/[\w-]+\.avature\.net\/[\w-]+/i,
  /https?:\/\/[\w-]+\.avature\.com\/[\w-]+/i,
  // Halogen
  /https?:\/\/[\w-]+\.halogensoftware\.com\/[\w-]+/i,
  // JobDiva
  /https?:\/\/[\w-]+\.jobdiva\.com\/[\w-]+/i,
  // CEIPHI (HCI)
  /https?:\/\/[\w-]+\.ceiphi\.com\/[\w-]+/i,
  // Talentree
  /https?:\/\/[\w-]+\.talentree\.com\/[\w-]+/i,
  // iCIMS
  /https?:\/\/[\w-]+\.icims\.com\/[\w-]+/i,
  // Workable (already in specific)
  /https?:\/\/apply\.workable\.com\/[\w-]+/i,
  // Lever (already in specific)
  /https?:\/\/jobs\.lever\.co\/[\w-]+/i,
  // Government job boards
  /https?:\/\/www\.USAJobs\.gov\/[\w-]+\/[\w-]+/i,
  /https?:\/\/[\w-]+\.governmentjobs\.com\/[\w-]+/i,
  /https?:\/\/[\w-]+\.statejobs\.ny\.gov\/[\w-]+/i,
  // Healthcare systems
  /https?:\/\/[\w-]+\.career\.visma\.com\/[\w-]+/i,
  /https?:\/\/careers\.[\w-]+\.edu\/[\w-]+/i,
  // UK job boards
  /https?:\/\/[\w-]+\.cv-library\.co\.uk\/[\w-]+/i,
  /https?:\/\/[\w-]+\.reed\.co\.uk\/[\w-]+/i,
  // Staffing agencies
  /https?:\/\/[\w-]+\.peoplemark\.com\/[\w-]+/i,
  /https?:\/\/[\w-]+\.kellyservices\.com\/[\w-]+/i,
  /https?:\/\/[\w-]+\.adeccousa\.com\/[\w-]+/i,
  /https?:\/\/[\w-]+\.manpower\.com\/[\w-]+/i,
];

// Generic careers-page patterns — last resort
const GENERIC_CAREERS_PATTERNS: Array<RegExp> = [
  /https?:\/\/(?:jobs?|careers?|apply|hire)\.[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s<>"]*)?/gi,
  /https?:\/\/[a-z0-9-]+\.[a-z]{2,}\/(?:jobs?|careers?|apply)(?:\/[^\s<>"]*)?/gi,
];

interface DescriptionHit {
  url:        string;
  atsType?:   AtsType;
  confidence: number;
}

function extractUrlFromDescription(description: string): DescriptionHit | null {
  // 1. ATS-specific URLs first (highest quality)
  for (const { atsType, re } of ATS_SPECIFIC_PATTERNS) {
    const m = description.match(re);
    if (m && !AGGREGATOR_PATTERN.test(m[0])) return { url: m[0], atsType, confidence: 0.95 };
  }

  // 2. Generic ATS platforms
  for (const re of ATS_GENERIC_PATTERNS) {
    const m = description.match(re);
    if (m && !AGGREGATOR_PATTERN.test(m[0])) return { url: m[0], confidence: 0.85 };
  }

  // 3. Look for any URL with job-like patterns (most likely to be exact job)
  const jobUrlPatterns = [
    /https?:\/\/[^\s"<>]*(?:\/jobs\/|\/job\/|\/position\/|\/vacancy\/|\/apply\/|\/careers\/)[^\s"<>]*/gi,
    /https?:\/\/[^\s"<>]*\/[a-z0-9-]+-\d{5,}[^\s"<>]*/gi,
    /https?:\/\/[^\s"<>]*\/rc\/[^\s"<>]*/gi,
    /https?:\/\/[^\s"<>]*\/viewjob[^\s"<>]*/gi,
    /https?:\/\/[^\s"<>]*\/jobs\/[^\s"<>]*/gi,
  ];

  for (const pattern of jobUrlPatterns) {
    for (const match of description.matchAll(pattern)) {
      const url = match[0];
      if (!url || AGGREGATOR_PATTERN.test(url)) continue;
      if (url.length < 25) continue;
      if (url.match(/\.(pdf|doc|docx|jpg|jpeg|png|gif|svg)$/i)) continue;
      if (url.includes(' unsubscribe') || url.includes('mailchi')) continue;
      return { url, confidence: 0.7 };
    }
  }

  // 4. Generic careers pages as fallback
  for (const pattern of GENERIC_CAREERS_PATTERNS) {
    for (const match of description.matchAll(pattern)) {
      if (!AGGREGATOR_PATTERN.test(match[0])) return { url: match[0], confidence: 0.4 };
    }
  }
  return null;
}

// ─── SearXNG fallback search ──────────────────────────────────────────────────
// Opt-in via SEARXNG_URL. Used as a final resort when prior steps couldn't find
// a specific job URL — e.g. small employers without a public ATS or homepage.

const SEARXNG_STOPWORDS = new Set([
  'the','and','of','in','at','for','a','an','to',
  'inc','llc','corp','co','ltd','company','group',
]);

const GENERIC_PATH_TERMINALS = new Set([
  'careers','jobs','apply','search','browse','openings',
  'opportunities','positions','vacancies','listing','explore',
]);

const NON_HTML_EXT_RE = /\.(pdf|doc|docx|csv|xls|xlsx|ppt|pptx|txt)(?:\?|$)/i;

function urlDomainMatchesCompany(url: string, company: string): boolean {
  try {
    const domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const tokens = company.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(t => t.length >= 4 && !SEARXNG_STOPWORDS.has(t));
    return tokens.some(t => domain.includes(t));
  } catch { return false; }
}

function urlIsSpecificJobPage(url: string): boolean {
  try {
    if (NON_HTML_EXT_RE.test(url)) return false;
    const path = new URL(url).pathname.split('/').filter(Boolean);
    if (path.length < 2) return false;
    const last = path[path.length - 1].toLowerCase();
    if (GENERIC_PATH_TERMINALS.has(last)) return false;
    return path.some(seg => /\d{4,}/.test(seg) || /^[0-9a-f-]{36}$/i.test(seg) || seg.length >= 20);
  } catch { return false; }
}

function urlIsAggregator(url: string): boolean {
  if (AGGREGATOR_PATTERN.test(url)) return true;
  try {
    return isAggregatorDomain(new URL(url).hostname);
  } catch { return false; }
}

function extractCity(location: string | undefined): string | null {
  if (!location) return null;
  const first = location.split(',')[0].trim();
  if (!first || /^(remote|united states|us|usa|anywhere)$/i.test(first)) return null;
  return first;
}

async function searchViaSearXNG(input: ResolveInput): Promise<ResolveResult | null> {
  const base = process.env.SEARXNG_URL?.replace(/\/$/, '');
  if (!base) return null;

  const city = extractCity(input.location);
  const query = [input.title, input.company, city].filter(Boolean).join(' ');
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=en-US`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!r.ok) return null;
    const json = await r.json() as { results?: Array<{ url?: string }> };
    const candidates = (json.results ?? [])
      .map(x => x.url)
      .filter((u): u is string => !!u && u.startsWith('http') && !urlIsAggregator(u));

    // Tier 1: ATS-specific URL — high confidence (typed match)
    for (const u of candidates) {
      for (const { atsType, re } of ATS_SPECIFIC_PATTERNS) {
        if (re.test(u)) return { url: u, resolved: true, resolvedVia: 'ats', atsType, confidence: 0.9 };
      }
    }
    // Tier 2: Generic ATS platform URL — still high confidence, but no atsType
    for (const u of candidates) {
      for (const re of ATS_GENERIC_PATTERNS) {
        if (re.test(u)) return { url: u, resolved: true, resolvedVia: 'ats', confidence: 0.8 };
      }
    }
    // Tier 3: Company-domain URL with a job-id-shaped path
    for (const u of candidates) {
      if (urlDomainMatchesCompany(u, input.company) && urlIsSpecificJobPage(u)) {
        return { url: u, resolved: true, resolvedVia: 'searxng', confidence: 0.7 };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── public API ───────────────────────────────────────────────────────────────

export interface ResolveInput {
  title:       string;
  company:     string;
  location?:   string;
  fallbackUrl: string;
  description?: string;
}

export type ResolvedVia = 'ats' | 'careers_page' | 'description' | 'scraped' | 'existing' | 'searxng' | 'fallback';

export interface ResolveResult {
  url:         string;
  resolved:    boolean;
  resolvedVia: ResolvedVia;
  atsType?:    AtsType;
  score?:      number;
  /** 0..1 — how certain we are this URL is right for the *specific* job. Callers can threshold this. */
  confidence:  number;
}

export async function resolveAdzunaLink(input: ResolveInput): Promise<ResolveResult> {
  const fallback: ResolveResult = { url: input.fallbackUrl, resolved: false, resolvedVia: 'fallback', confidence: 0 };
  try {
    // 0. Check if already has an exact ATS URL (from previous processing or external data)
    if (input.fallbackUrl && !AGGREGATOR_PATTERN.test(input.fallbackUrl)) {
      for (const { atsType, re } of ATS_SPECIFIC_PATTERNS) {
        if (re.test(input.fallbackUrl)) {
          return { url: input.fallbackUrl, resolved: true, resolvedVia: 'existing', atsType, confidence: 1.0 };
        }
      }
      for (const re of ATS_GENERIC_PATTERNS) {
        if (re.test(input.fallbackUrl)) {
          return { url: input.fallbackUrl, resolved: true, resolvedVia: 'existing', confidence: 0.85 };
        }
      }
    }

    // 1. ATS deep-link via catalog / DB
    const info = await getCompanyCached(input.company);
    if (info.atsType && info.jobs.length > 0) {
      const best = pickBestMatch({ title: input.title, location: input.location }, info.jobs);
      if (best && best.score >= MATCH_THRESHOLD) {
        return { url: best.item.url, resolved: true, resolvedVia: 'ats', atsType: info.atsType, score: best.score, confidence: Math.min(1, best.score) };
      }
    }

    // 2. URL in description text — free, no network, before any HTTP fallbacks
    if (input.description) {
      const hit = extractUrlFromDescription(input.description);
      if (hit) {
        return {
          url: hit.url,
          resolved: true,
          resolvedVia: hit.atsType ? 'ats' : 'description',
          atsType: hit.atsType,
          confidence: hit.confidence,
        };
      }
    }

    // 3. Known careers page from catalog (staffing / healthcare / no-public-ATS companies)
    const entry = await lookupCatalogEntry(input.company);
    if (entry?.careersUrl) {
      return { url: entry.careersUrl, resolved: true, resolvedVia: 'careers_page', confidence: 0.7 };
    }

    // 4. Clearbit → domain guess → careers page analysis (ATS embed + JSON-LD) → deep-link
    let careersFallback: ResolveResult | null = null;
    const homepage = await resolveHomepage(input.company);
    if (homepage) {
      const base = homepage.replace(/\/$/, '');
      const analysis = await analyzeCareersPage(homepage);

      // 4a. ATS embed detected → query their API → title-match
      if (analysis?.embed) {
        const jobs = await listAtsJobs(analysis.embed.atsType, analysis.embed.atsId);
        if (jobs.length > 0) {
          const best = pickBestMatch({ title: input.title, location: input.location }, jobs);
          if (best && best.score >= MATCH_THRESHOLD) {
            return { url: best.item.url, resolved: true, resolvedVia: 'ats', atsType: analysis.embed.atsType, score: best.score, confidence: Math.min(1, best.score) };
          }
        }
      }

      // 4b. JSON-LD JobPosting on the careers page → title-match
      if (analysis?.jsonLdJobs.length) {
        const best = pickBestMatch({ title: input.title, location: input.location }, analysis.jsonLdJobs);
        if (best && best.score >= MATCH_THRESHOLD) {
          return { url: best.item.url, resolved: true, resolvedVia: 'ats', score: best.score, confidence: Math.min(1, best.score) };
        }
      }

      // Hold the generic /careers landing as a low-confidence option; SearXNG may beat it.
      careersFallback = { url: `${base}/careers`, resolved: true, resolvedVia: 'careers_page', confidence: 0.3 };
    }

    // 5. SearXNG search — opt-in via SEARXNG_URL. Final resort for hard cases
    //    (small regional employers, staffing, gov entities) before falling back.
    const searxngHit = await searchViaSearXNG(input);
    if (searxngHit) return searxngHit;

    if (careersFallback) return careersFallback;
    return fallback;
  } catch {
    return fallback;
  }
}

export async function resolveAdzunaLinksBatch(
  items: ResolveInput[],
  opts?: { concurrency?: number; timeoutMs?: number },
): Promise<ResolveResult[]> {
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 8, 16));
  const timeoutMs   = opts?.timeoutMs ?? 12_000;

  const results: ResolveResult[] = items.map(i => ({
    url: i.fallbackUrl, resolved: false, resolvedVia: 'fallback' as ResolvedVia, confidence: 0,
  }));

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await resolveAdzunaLink(items[i]);
    }
  }

  const work = Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  const timer = new Promise<void>(resolve => setTimeout(resolve, timeoutMs));
  await Promise.race([work, timer]);

  return results;
}

export function _resetCacheForTests(): void {
  companyCache.clear();
  inflight.clear();
  homepageCache.clear();
  homepageInflight.clear();
  careersCache.clear();
  careersInflight.clear();
  approvedMap = null;
  approvedLoadedAt = 0;
}
