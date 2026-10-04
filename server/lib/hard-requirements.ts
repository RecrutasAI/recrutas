/**
 * Hard requirements a job posting states, and the honest verdict for one
 * candidate: Apply, Stretch, or Skip.
 *
 * Measured 2026-10-04 on a real feed: 7 of the top 10 jobs for an IT-support
 * resume required US citizenship or a security clearance, and the match score
 * (skills and titles only) rated them 66-76%. Candidates were being shown jobs
 * they could not get. This reads the requirements that disqualify outright
 * and compares them with what the candidate told us (Settings → Application
 * answers) and their resume.
 *
 * Deliberately conservative: a requirement counts only when the posting states
 * it as required, and "preferred"/"nice to have" lines are ignored. A verdict
 * never treats an unanswered question as a no: it says what to check instead.
 */

export type ClearanceLevel = 'public_trust' | 'secret' | 'top_secret' | 'ts_sci';

export interface HardRequirements {
  /** An active clearance the posting requires (not "ability to obtain"). */
  clearance: ClearanceLevel | null;
  /** The posting asks for the ability to obtain a clearance (usually needs US citizenship). */
  clearanceObtainable: boolean;
  /** US citizenship required. */
  usCitizen: boolean;
  /** "US person" (citizen or permanent resident), typical of export-controlled roles. */
  usPerson: boolean;
  /** The employer says it will not sponsor visas. */
  noSponsorship: boolean;
  /** The highest required years of experience stated (preferred lines ignored). */
  minYears: number | null;
}

const PREFERRED_RE = /\b(prefer(red|ably)?|nice[- ]to[- ]have|a plus|bonus|desir(ed|able)|ideally)\b/i;

const CLEARANCE_RES: [ClearanceLevel, RegExp][] = [
  ['ts_sci', /\bTS\s*\/\s*SCI\b|\btop secret\s*\/\s*SCI\b|\btop secret SCI\b|\bSCI (eligib|access)|\beligib\w* for SCI\b|\bSCI clearance\b/i],
  ['top_secret', /\btop[- ]secret\b|\bTS clearance\b/i],
  ['secret', /\bsecret (security )?clearance\b|\bactive secret\b|\bDoD secret\b/i],
  ['public_trust', /\bpublic trust\b.{0,40}\b(clearance|position|investigation|background|determination|suitability)|\b(clearance|position|investigation)\b.{0,30}\bpublic trust\b/i],
];
const LEVEL_RANK: Record<ClearanceLevel, number> = { public_trust: 1, secret: 2, top_secret: 3, ts_sci: 4 };
const OBTAIN_RE = /\b(ability|able|eligib\w*) to (obtain|get|acquire|be granted)\b|\b(obtain|acquire)\b.{0,30}\bclearance\b|\bclearance eligib|\beligible for (a )?(security )?clearance/i;

const US_CITIZEN_RE = /\b(u\.?s\.?|united states)\s+citizen(ship)?\b.{0,60}\b(required|is required|must|mandatory|necessary)\b|\bmust (be|hold) (a )?(u\.?s\.?|united states) citizen|\b(requires?|required:?) (u\.?s\.?|united states) citizenship|\bonly (u\.?s\.?|united states) citizens\b/i;
const US_PERSON_RE = /\bU\.?S\.? persons?\b|\bITAR\b|\bexport[- ]control(led)?\b.{0,80}\b(citizen|permanent resident|green card|u\.?s\.? person)/i;
const NO_SPONSOR_RE = /\b(not|unable to|cannot|can't|won't|will not|do not|does not|don't|doesn't|no longer)\s+(be able to\s+)?(offer|provide|consider|support)?\s*(visa\s+|immigration\s+|employment\s+)?sponsor(ship)?\b|\bsponsorship (is )?not (available|offered|provided|possible)\b|\bno (visa |immigration )?sponsorship\b|\bwithout (the )?(need|requirement) (for|of) (visa |immigration )?sponsorship/i;
const YEARS_RE = /\b(\d{1,2})\s*(?:\+|plus)?\s*(?:-|to|–)?\s*(?:\d{1,2}\s*)?\+?\s*years?\b(?:\s+of)?[^.\n]{0,60}?\bexperience\b|\bexperience\b[^.\n]{0,25}?\b(\d{1,2})\s*\+?\s*years?\b|\bminimum (?:of )?(\d{1,2})\s*years?\b/gi;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-' };

/** Stored descriptions are often HTML, sometimes entity-escaped twice. */
export function descriptionToText(raw: string): string {
  let t = raw;
  for (let i = 0; i < 2; i++) {
    t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  }
  return t
    .replace(/<\s*(br|\/p|\/li|\/div|\/h\d|li|p|div|h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

function sentences(text: string): string[] {
  // Keep "U.S." / "e.g." intact: splitting on their periods cut
  // "must be a U.S. citizen" in two and hid every citizenship requirement.
  const protectedText = descriptionToText(text)
    .replace(/\bU\.\s?S\.(?:\s?A\.)?/g, 'US')
    .replace(/\b(e\.g|i\.e|etc|incl|approx)\./gi, '$1');
  return protectedText.split(/(?<=[.!?;])\s+|\n+|•|·/).map(s => s.trim()).filter(Boolean);
}

export function extractHardRequirements(description: string | null | undefined): HardRequirements {
  const req: HardRequirements = { clearance: null, clearanceObtainable: false, usCitizen: false, usPerson: false, noSponsorship: false, minYears: null };
  if (!description) {return req;}
  for (const s of sentences(description.slice(0, 20000))) {
    const preferred = PREFERRED_RE.test(s);
    if (!preferred) {
      // The sentence must state a requirement, not describe the work
      // ("protect TS/SCI networks").
      if (/clearance|top secret|TS\s*\/\s*SCI|public trust/i.test(s)
          && /\b(clearance|required|requires?|must|active|current|eligib\w*|poly(graph)?|hold|possess|obtain)\b/i.test(s)) {
        if (OBTAIN_RE.test(s)) {
          req.clearanceObtainable = true;
        } else {
          for (const [level, re] of CLEARANCE_RES) {
            if (re.test(s) && (!req.clearance || LEVEL_RANK[level] > LEVEL_RANK[req.clearance])) {req.clearance = level;}
          }
        }
      }
      // "citizen or permanent resident" is the broader US-person rule, not
      // citizenship: reading it as citizens-only would turn away green-card holders.
      if (US_CITIZEN_RE.test(s)) {
        if (/permanent resident|green card|lawful(ly)? admitted|asylee|refugee/i.test(s)) {req.usPerson = true;}
        else {req.usCitizen = true;}
      }
      if (US_PERSON_RE.test(s)) {req.usPerson = true;}
      for (const m of s.matchAll(YEARS_RE)) {
        const n = Number(m[1] ?? m[2] ?? m[3]);
        if (n >= 1 && n <= 15 && (req.minYears === null || n > req.minYears)) {req.minYears = n;}
      }
    }
    // Sponsorship statements are often phrased as a note, not a requirement.
    if (NO_SPONSOR_RE.test(s)) {req.noSponsorship = true;}
  }
  // A clearance requirement implies the posting is closed to non-citizens too.
  return req;
}

export interface CandidateFacts {
  usCitizen?: 'yes' | 'no';
  needsSponsorship?: 'yes' | 'no';
  workAuthorizedUS?: 'yes' | 'no';
  securityClearance?: 'none' | ClearanceLevel;
  /** Years of experience from the resume, if known. */
  years?: number | null;
}

export type VerdictLabel = 'apply' | 'stretch' | 'skip';
export interface Verdict {
  label: VerdictLabel;
  /** Plain-language reasons, most important first. */
  reasons: string[];
  /** Questions the candidate hasn't answered that this job depends on. */
  toCheck: string[];
}

const CLEARANCE_NAME: Record<ClearanceLevel, string> = { public_trust: 'Public Trust', secret: 'Secret', top_secret: 'Top Secret', ts_sci: 'TS/SCI' };

/**
 * Compare a job's hard requirements with the candidate. `matchScore` is the
 * feed's skills/title score; a strong-enough fit with no conflicts is Apply.
 */
export function verdictFor(req: HardRequirements, facts: CandidateFacts, matchScore: number): Verdict {
  const blockers: string[] = [];
  const gaps: string[] = [];
  const toCheck: string[] = [];

  if (req.clearance === 'public_trust') {
    // A background investigation usually run after the offer, unlike Secret
    // and above, which a candidate must already hold. A stretch, not a no.
    if (!facts.securityClearance || facts.securityClearance === 'none') {
      gaps.push('Requires a Public Trust background check (usually done after hire)');
    }
  } else if (req.clearance) {
    const need = CLEARANCE_NAME[req.clearance];
    if (!facts.securityClearance) {toCheck.push(`Requires an active ${need} clearance`);}
    else if (facts.securityClearance === 'none' || LEVEL_RANK[facts.securityClearance as ClearanceLevel] < LEVEL_RANK[req.clearance]) {
      blockers.push(`Requires an active ${need} clearance`);
    }
  }
  if (req.usCitizen || req.clearanceObtainable) {
    const what = req.usCitizen ? 'Requires US citizenship' : 'Requires being able to obtain a clearance (US citizens only)';
    if (!facts.usCitizen) {toCheck.push(what);}
    else if (facts.usCitizen === 'no') {blockers.push(what);}
  } else if (req.usPerson) {
    // US person = citizen or permanent resident. Someone needing sponsorship is neither.
    if (facts.usCitizen !== 'yes') {
      if (facts.needsSponsorship === 'yes') {blockers.push('Export-controlled: requires US citizen or permanent resident');}
      else if (!facts.usCitizen && !facts.needsSponsorship) {toCheck.push('Export-controlled: requires US citizen or permanent resident');}
    }
  }
  if (req.noSponsorship) {
    if (facts.needsSponsorship === 'yes') {blockers.push("Won't sponsor a visa");}
    else if (!facts.needsSponsorship && facts.usCitizen !== 'yes') {toCheck.push("Won't sponsor a visa");}
  }
  if (req.minYears !== null && facts.years != null) {
    const gap = req.minYears - facts.years;
    if (gap >= 4) {blockers.push(`Asks for ${req.minYears}+ years; you have about ${facts.years}`);}
    else if (gap >= 1) {gaps.push(`Asks for ${req.minYears}+ years; you have about ${facts.years}`);}
  }

  if (blockers.length) {return { label: 'skip', reasons: [...blockers, ...gaps], toCheck };}
  if (gaps.length || matchScore < 60) {
    return { label: 'stretch', reasons: gaps.length ? gaps : ['Partial fit for your skills and experience'], toCheck };
  }
  return { label: 'apply', reasons: ['You meet the stated requirements'], toCheck };
}

/**
 * Rough years of experience from parsed resume positions' durations
 * ("2019 - 2023", "Jan 2021 – Present"). Overlaps are merged; null if none parse.
 */
export function yearsFromPositions(positions: Array<{ duration?: string }> | null | undefined, now = new Date()): number | null {
  if (!Array.isArray(positions)) {return null;}
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const nowM = now.getFullYear() * 12 + now.getMonth();
  // Dates in a duration, as month indexes: "May 2020", "05/2020", or "2020"
  // (a bare year counts as January for a start and December for an end).
  const points = (d: string): Array<{ m: number; yearOnly: boolean }> =>
    [...d.matchAll(/\b(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+|(\d{1,2})\/)?(19[5-9]\d|20[0-4]\d)\b/gi)].map(m => {
      const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) : m[2] ? Number(m[2]) - 1 : null;
      return { m: Number(m[3]) * 12 + (month ?? 0), yearOnly: month === null };
    });
  const spans: [number, number][] = [];
  for (const p of positions) {
    const d = p?.duration || '';
    const pts = points(d);
    if (!pts.length) {continue;}
    const start = pts[0].m;
    const last = pts[pts.length - 1];
    const end = /present|current|now/i.test(d) ? nowM : (pts.length > 1 ? last.m + (last.yearOnly ? 11 : 0) : start + 11);
    if (end > start) {spans.push([start, Math.min(end, nowM)]);}
  }
  if (!spans.length) {return null;}
  spans.sort((a, b) => a[0] - b[0]);
  let months = 0, [cs, ce] = spans[0];
  for (const [s2, e2] of spans.slice(1)) {
    if (s2 <= ce) {ce = Math.max(ce, e2);} else {months += ce - cs; [cs, ce] = [s2, e2];}
  }
  months += ce - cs;
  // Round down: claiming more experience than the resume shows is the worse error.
  return Math.floor(months / 12);
}
