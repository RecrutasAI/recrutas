/**
 * What a parsed resume says, read the same way wherever it's used.
 *
 * Parsed resumes are stored in two shapes: `positions` at the top level (every resume parsed in
 * production as of 2026-10-12) or under `experience.positions` (the parser's documented shape).
 * Reading only the second left the autofill without a single employer or year. Years are worked
 * out from each role's dates ("September 2022 – Present"), overlaps counted once, and always
 * rounded down: a form answer never overstates experience.
 */

export interface ResumePosition { title: string; company: string; duration: string; lines: string[] }
export interface ResumeFacts {
  positions: ResumePosition[];
  companies: string[];
  /** Whole years across all dated roles, or the parser's own total when no role has dates. */
  totalYears: number | null;
  text: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A role's dates as months since year 0, [start, end); null when they can't be read. */
export function durationRange(duration: string, now: Date = new Date()): [number, number] | null {
  const parts = String(duration || '').split(/\s*(?:–|—|-|\bto\b|\buntil\b)\s*/i).filter(Boolean);
  if (parts.length < 2) {return null;}
  const point = (s: string, end: boolean): number | null => {
    if (/present|current|now|today/i.test(s)) {return now.getUTCFullYear() * 12 + now.getUTCMonth() + 1;}
    const year = s.match(/\b(19[5-9]\d|20\d\d)\b/);
    if (!year) {return null;}
    const y = Number(year[1]);
    const name = MONTHS.findIndex(m => new RegExp(`\\b${m}`, 'i').test(s));
    const num = s.match(/\b(0?[1-9]|1[0-2])\s*[/.]\s*(?:19|20)\d\d\b/);
    const month = name >= 0 ? name : num ? Number(num[1]) - 1 : end ? 11 : 0;
    return y * 12 + month + (end ? 1 : 0);
  };
  const start = point(parts[0], false);
  const end = point(parts[parts.length - 1], true);
  return start != null && end != null && end > start ? [start, end] : null;
}

/** Whole years covered by these ranges, overlaps counted once. */
export function yearsCovered(ranges: Array<[number, number]>): number {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let months = 0;
  let cur: [number, number] | null = null;
  for (const r of sorted) {
    if (cur && r[0] <= cur[1]) {cur[1] = Math.max(cur[1], r[1]);} else {
      if (cur) {months += cur[1] - cur[0];}
      cur = [r[0], r[1]];
    }
  }
  if (cur) {months += cur[1] - cur[0];}
  return Math.floor(months / 12);
}

export function resumeFacts(parsed: any, resumeText?: string | null, now: Date = new Date()): ResumeFacts {
  const raw: any[] = Array.isArray(parsed?.positions) ? parsed.positions
    : Array.isArray(parsed?.experience?.positions) ? parsed.experience.positions : [];
  const positions: ResumePosition[] = raw
    .filter(p => p && (p.title || p.company))
    .map(p => ({
      title: String(p.title ?? '').trim(),
      company: String(p.company ?? '').trim(),
      duration: String(p.duration ?? '').trim(),
      lines: [...(Array.isArray(p.responsibilities) ? p.responsibilities : []), ...(p.description ? [p.description] : [])]
        .map((l: unknown) => String(l ?? '').trim()).filter(Boolean),
    }));
  const ranges = positions.map(p => durationRange(p.duration, now)).filter((r): r is [number, number] => !!r);
  const parserTotal = Number(parsed?.experience?.totalYears ?? parsed?.totalYears);
  return {
    positions,
    companies: positions.map(p => p.company).filter(Boolean),
    totalYears: ranges.length ? yearsCovered(ranges) : Number.isFinite(parserTotal) && parserTotal > 0 ? Math.floor(parserTotal) : null,
    text: String(resumeText ?? ''),
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Years in roles whose title or lines name `subject` ("Kubernetes", "customer support"), with the
 * roles as evidence. Null when no dated role names it: the resume doesn't say, so a form can't.
 */
export function yearsWith(facts: ResumeFacts, subject: string, now: Date = new Date()): { years: number; evidence: string } | null {
  const s = subject.trim();
  if (s.length < 2) {return null;}
  const re = new RegExp(`(^|[^a-z0-9+#])${escape(s.toLowerCase())}($|[^a-z0-9+#])`, 'i');
  const roles = facts.positions
    .map(p => ({ p, range: durationRange(p.duration, now) }))
    .filter(({ p, range }) => range && [p.title, ...p.lines].some(l => re.test(l.toLowerCase())));
  if (!roles.length) {return null;}
  const years = yearsCovered(roles.map(r => r.range!));
  const named = roles.slice(0, 3).map(({ p }) => `${p.title}${p.company ? ` at ${p.company}` : ''} (${p.duration})`).join('; ');
  return { years, evidence: `Roles on your resume that mention ${s}: ${named}` };
}

const DEGREES: Array<[string, RegExp]> = [
  ['Doctorate', /\b(ph\.?\s?d|doctor(ate)? of|d\.?phil|ed\.?d)\b/i],
  // Abbreviations only with their dots or "in" after them: "Boston, MA" is not a master's.
  ["Master's degree", /\bmaster'?s?\b|\bm\.(s|a|sc|eng)\.?(?=\s|,|$)|\b(ms|ma|msc) in\b|\bmba\b/i],
  ["Bachelor's degree", /\bbachelor'?s?\b|\bb\.(s|a|sc|eng|tech)\.?(?=\s|,|$)|\b(bs|ba|bsc) in\b|\bbtech\b/i],
  ["Associate's degree", /\bassociate'?s? (of|degree|in)\b|\ba\.a\.s?\b/i],
  ['High school diploma or GED', /\bhigh school\b|\bged\b|secondary school/i],
];

/** The highest degree the resume text names, with the line it's on. */
export function highestEducation(facts: ResumeFacts): { level: string; evidence: string } | null {
  const lines = facts.text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  for (const [level, re] of DEGREES) {
    const line = lines.find(l => re.test(l));
    if (line) {return { level, evidence: `On your resume: "${line.slice(0, 120)}"` };}
  }
  return null;
}
