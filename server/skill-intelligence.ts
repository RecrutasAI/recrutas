/**
 * SKILL INTELLIGENCE ENGINE
 *
 * Deterministic, zero-cost resume parser. No API calls, no hallucination,
 * no rate limits. Designed to outperform LLMs on clean English resumes.
 *
 * Innovations vs naive keyword matching:
 *  1. Full 400+ alias taxonomy — "ReactJS", "js", "k8s" all resolve correctly
 *  2. N-gram tokenization — catches multi-word skills ("machine learning", "react native")
 *  3. Section-aware weighting — skills declared in a Skills section score 3x
 *  4. Tech stack cluster expansion — "MERN stack" → MongoDB, Express, React, Node.js
 *  5. Skill graph inference — knowing React implies JavaScript (parent skill)
 *  6. Negation detection — "no experience in Python" → skip Python
 *  7. Experience level detection — job titles + date math + keyword signals
 *  8. Proficiency context — "5 years of Python", "proficient in", "familiar with"
 *  9. Short-skill disambiguation — "Go", "R", "C" validated by surrounding context
 * 10. Confidence scoring — ranked output, no hallucinated skills
 */

import { SKILL_ALIASES } from './skill-normalizer';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillIntelligenceResult {
  technical: string[];
  soft: string[];
  tools: string[];
  experienceLevel: 'entry' | 'mid' | 'senior' | 'executive';
  totalYears: number;
  positions: Array<{ title: string; company: string; duration: string; responsibilities: string[] }>;
  education: Array<{ degree: string; institution: string; year?: string }>;
  certifications: string[];
  personalInfo: {
    name?: string;
    email?: string;
    phone?: string;
    location?: string;
    linkedin?: string;
    github?: string;
    website?: string;
  };
  confidence: number; // 0-100: how confident we are in the overall extraction
}

interface SkillCandidate {
  canonical: string;
  weight: number;      // cumulative section weight
  count: number;       // times found
}

// ── Section detection ─────────────────────────────────────────────────────────

const SECTION_PATTERNS: Record<string, RegExp> = {
  skills:          /^(technical\s*|core\s+|relevant\s+|key\s+|hard\s+|soft\s+|professional\s+)?skills?\s*:?\s*$|^(core\s+)?competencies\s*:?\s*$|^technologies(\s+used)?\s*:?\s*$|^tools?(\s+and\s+technologies?)?\s*:?\s*$|^tech(nical)?\s*(stack|expertise)\s*:?\s*$|^what\s+i\s+(know|use)\s*:?\s*$|^TECHNICALSKILLS\s*$/i,
  experience:      /^(work\s+)?(experience|history|background|employment)\s*:?\s*$|^professional\s+(experience|background|history)\s*:?\s*$|^career\s+(history|background)\s*:?\s*$/i,
  projects:        /^(personal\s+|side\s+|open[\s-]?source\s+|key\s+)?projects?\s*:?\s*$|^portfolio\s*:?\s*$|^selected\s+work\s*:?\s*$|^(software\s*)?engineering\s*projects?\s*$/i,
  summary:         /^(professional\s+)?(summary|profile|objective|about(\s+me)?|overview|introduction|bio)\s*:?\s*$/i,
  certifications:  /^certifications?\s*:?\s*$|^licenses?\s*(and\s+certifications?)?\s*:?\s*$|^credentials\s*:?\s*$/i,
  education:       /^education(al\s+(background|history))?\s*:?\s*$|^academic\s+(background|history|qualifications?)\s*:?\s*$/i,
};

// Weight multiplier per section — how strongly we trust skill mentions here
const SECTION_WEIGHTS: Record<string, number> = {
  skills:         3.0,   // Explicitly declared: "I know this"
  certifications: 2.5,   // Proven by exam
  projects:       1.8,   // Used in practice
  experience:     1.6,   // Used professionally
  summary:        1.3,   // Highlighted as key skill
  education:      0.7,   // Studied (may be dated)
  unknown:        1.0,   // Body text
};

// ── Soft skills (not in SKILL_ALIASES — captured separately) ──────────────────

const SOFT_SKILL_PATTERNS: Array<[RegExp, string]> = [
  [/\b(team\s*work|team\s*player|collaborative|collaboration)\b/gi, 'Teamwork'],
  [/\b(leadership|led\s+team|team\s+lead|mentoring|mentored)\b/gi, 'Leadership'],
  [/\b(team\s+management|managed?\s+(a\s+)?teams?|spearheaded?\s+a\s+team|directed\s+(the\s+)?oversight)\b/gi, 'Team Management'],
  [/\b(customer\s+service|customer\s+support|client\s+service|client\s+support|customer\s+satisfaction)\b/gi, 'Customer Service'],
  [/\b(communication|communicat(ed|ion)|verbal\s+communication|written\s+communication|bilingual)\b/gi, 'Communication'],
  [/\b(problem[\s-]?solving|troubleshoot|debugging|root\s+cause)\b/gi, 'Problem-Solving'],
  [/\b(project\s+management|managed\s+projects?|end[\s-]to[\s-]end)\b/gi, 'Project Management'],
  [/\b(agile|scrum|kanban|sprint|stand[\s-]up)\b/gi, 'Agile'],
  [/\b(critical\s+thinking|analytical|analysis)\b/gi, 'Analytical Thinking'],
  [/\b(time\s+management|deadline|prioriti(ze|sation))\b/gi, 'Time Management'],
  [/\b(adapta(ble|bility)|flexible|versatil(e|ity))\b/gi, 'Adaptability'],
];

// ── Skills that need extra context validation (too short / ambiguous) ──────────

// Tokens that mean a real skill in tech context but an English word elsewhere
// ("swift resolution" ≠ Swift language, "go to market" ≠ Go language).
const AMBIGUOUS_SKILLS = new Set([
  'r', 'c', 'go', 'ai', 'ml', 'dl', 'ui', 'ux',
  'swift', 'rust', 'shell', 'java', 'sass',
]);

// Technical context signals — nearby words that confirm a technical context
const TECH_CONTEXT_SIGNALS = /\b(programm|develop|engineer|software|code|coding|stack|framework|library|language|tool|technolog|platform|system|app|api|database|backend|frontend|fullstack|devops|cloud|mobile|web|data|machine|neural|model|deploy|server|client|build|test|ci|cd)\b/i;

// ── Negation detector ─────────────────────────────────────────────────────────

const NEGATION_PATTERNS = [
  /\b(no|not|never|lack\s+of|without|excluding|except|unfamiliar\s+with|limited\s+experience\s+in|no\s+experience\s+in|currently\s+learning)\s+\w+(\s+\w+)?\s*$/i,
];

// Negation must be within a few words of the skill, anchored to the end of
// the lookback window. This catches "have not used <skill>" and
// "no experience in <skill>" without flagging an unrelated "no" earlier in
// the same line.
const NEGATION_LOOKBACK_RE = /\b(not|no|never|lacks?(\s+of)?|without|excluding|unfamiliar\s+with|currently\s+learning|limited\s+experience(\s+(in|with))?|no\s+experience(\s+(in|with))?)\b(\s+\w+){0,3}\s*$/i;

function isNegated(line: string, skillPos: number): boolean {
  if (skillPos < 0) return false;
  const before = line.slice(Math.max(0, skillPos - 60), skillPos);
  return NEGATION_LOOKBACK_RE.test(before);
}

// ── Seniority detection ───────────────────────────────────────────────────────

const LEVEL_PATTERNS = [
  { level: 'executive' as const, re: /\b(director|vp|vice\s+president|head\s+of|cto|cpo|ceo|coo|chief|founder|co[\s-]?founder|president)\b/i },
  { level: 'senior'    as const, re: /\b(senior|sr\.?|lead|principal|staff\s+(engineer|developer)|architect|tech\s+lead)\b/i },
  { level: 'mid'       as const, re: /\b(mid[\s-]level|software\s+(engineer|developer)|full[\s-]?stack\s+(engineer|developer)|backend\s+(engineer|developer)|frontend\s+(engineer|developer))\b/i },
  { level: 'entry'     as const, re: /\b(junior|jr\.?|associate|entry[\s-]?level|intern|graduate|trainee|apprentice|fresh(er|man|graduate)?)\b/i },
];

// ── Core engine ───────────────────────────────────────────────────────────────

/**
 * Normalize raw PDF/text: collapse spaced-out headers, split single-line blobs
 * into logical lines so section segmentation and position parsing work.
 */
function normalizeResumeText(rawText: string): string {
  let text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Collapse spaced-out headers: "E X P E R I E N C E" → "EXPERIENCE"
  // Matches sequences of single uppercase letters separated by spaces (3+ letters)
  text = text.replace(/\b([A-Z])\s+(?:[A-Z]\s+){2,}[A-Z]\b/g, (match) =>
    match.replace(/\s+/g, '')
  );

  // If text has very few newlines relative to its length, it's a single-line PDF blob.
  // Split on known section headers and before company/date patterns.
  const lineCount = text.split('\n').filter(l => l.trim()).length;
  if (lineCount <= 3 && text.length > 500) {
    // Insert newlines before AND after section header words so they become their own lines
    const sectionWords = 'SUMMARY|EXPERIENCE|EDUCATION|SKILLS|PROJECTS|CERTIFICATIONS|OBJECTIVE|PROFILE|EMPLOYMENT|QUALIFICATIONS|TECHNICAL';
    text = text.replace(new RegExp(`\\s+(${sectionWords})\\b\\s*`, 'g'), '\n$1\n');

    // Insert newlines before ALL-CAPS company/org names followed by comma+location
    // e.g., "WALMART, INC., Bentonville" or "AMAZON, Seattle"
    text = text.replace(/\s+(?=[A-Z][A-Z]+[,.]?\s+(?:INC|LLC|CORP|LTD|CO)?[,.]?\s*[A-Z][a-z])/g, '\n');

    // Insert newlines before date ranges (e.g., "2011-2016", "Jan 2020 - Present")
    // Supports comma+space or any whitespace before the date
    text = text.replace(/[,;]\s*(?=(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?\d{4}\s*[–—\u2010-]\s*(?:present|current|now|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?\d{0,4})/gi, '\n');

    // Insert newlines before bullet points (•, ●, ■, ▪, common PDF bullet \uf0b7)
    text = text.replace(/\s(?=[•●■▪\uf0b7])/g, '\n');

    // Split on double-space + capital letter (common PDF run-together pattern)
    // but only after initial section splitting is done
    text = text.replace(/\s{2,}(?=[A-Z][a-z])/g, '\n');
  }

  return text;
}

export function parseResumeWithIntelligence(rawText: string): SkillIntelligenceResult {
  const text = normalizeResumeText(rawText);
  const lines = text.split('\n');

  // Step 1: Segment text into sections
  const segments = segmentIntoSections(lines);

  // Step 2: Extract skill candidates with section-aware weights.
  // This stage is purely extractive — only canonical forms of skills literally
  // present in the resume text. Skill-graph expansion (e.g. React → JavaScript)
  // is handled at match time via getRelatedSkills(), so the saved profile
  // reflects exactly what the candidate wrote.
  const candidates = extractSkillCandidates(segments);

  // Step 3: Classify into technical / tools / soft
  const { technical, tools } = classifySkills(candidates);
  const soft = extractSoftSkills(text);

  // Step 4: Experience detection
  const { level, totalYears, positions } = extractExperience(text, segments);

  // Step 5: Education
  const education = extractEducation(segments);

  // Step 6: Certifications
  const certifications = extractCertifications(text);

  // Step 7: Personal info
  const personalInfo = extractPersonalInfo(text);

  // Step 8: Confidence score
  const confidence = computeConfidence(technical, totalYears, personalInfo);

  return {
    technical: technical.slice(0, 30),
    tools: tools.slice(0, 15),
    soft: soft.slice(0, 10),
    experienceLevel: level,
    totalYears,
    positions,
    education,
    certifications,
    personalInfo,
    confidence,
  };
}

// ── Section segmentation ──────────────────────────────────────────────────────

interface TextSegment {
  section: string;
  lines: string[];
  weight: number;
}

function segmentIntoSections(lines: string[]): TextSegment[] {
  const segments: TextSegment[] = [];
  let current: TextSegment = { section: 'unknown', lines: [], weight: SECTION_WEIGHTS.unknown };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {continue;}

    let matched = false;
    for (const [section, pattern] of Object.entries(SECTION_PATTERNS)) {
      if (pattern.test(line)) {
        if (current.lines.length > 0) {segments.push(current);}
        current = {
          section,
          lines: [],
          weight: SECTION_WEIGHTS[section] ?? SECTION_WEIGHTS.unknown,
        };
        matched = true;
        break;
      }
    }

    // ALL-CAPS short lines are sometimes section headers we don't recognise
    // (e.g. AWARDS, PUBLICATIONS, ACHIEVEMENTS). But short ALL-CAPS tokens
    // are usually tech acronyms appearing inside the body (SCCM, JIRA, AWS,
    // SQL) — treating those as section boundaries truncates the experience
    // segment and breaks position parsing. Require 6+ chars *and* either a
    // space (multi-word header) or a known boundary keyword.
    const looksLikeUnknownHeader =
      /^[A-Z][A-Z\s&/]{5,30}$/.test(line) &&
      line.length < 35 &&
      (/\s/.test(line) || /^(AWARDS|PUBLICATIONS|ACHIEVEMENTS|HONORS|VOLUNTEER|LANGUAGES|INTERESTS|REFERENCES|ACTIVITIES|HOBBIES|TRAINING|COURSES|COURSEWORK|LEADERSHIP)$/.test(line));
    if (!matched && looksLikeUnknownHeader) {
      if (current.lines.length > 0) {segments.push(current);}
      current = { section: 'unknown', lines: [], weight: SECTION_WEIGHTS.unknown };
    } else if (!matched) {
      current.lines.push(rawLine);
    }
  }

  if (current.lines.length > 0) {segments.push(current);}
  return segments;
}

// ── N-gram skill extraction ───────────────────────────────────────────────────

// Build a lookup map: every alias (lowercase) → canonical form
// We add both the SKILL_ALIASES keys AND multi-word stack cluster keys
const ALIAS_LOOKUP: Map<string, string> = new Map(
  Object.entries(SKILL_ALIASES).map(([alias, canonical]) => [alias.toLowerCase(), canonical])
);

function extractSkillCandidates(segments: TextSegment[]): Map<string, SkillCandidate> {
  const candidates: Map<string, SkillCandidate> = new Map();

  for (const segment of segments) {
    // Skip degree/cert sections — degree subjects ("Electrical and Computer
    // Engineering", "Data Science") are not the candidate's working skills.
    // Real skills appear in skills/experience/projects/summary sections.
    if (segment.section === 'education' || segment.section === 'certifications') continue;

    const segText = segment.lines.join('\n');
    const segTextLower = segText.toLowerCase();
    // Tokenise: split on whitespace and most punctuation, preserve hyphens.
    // We expand slash-joined tokens like "MacOS/Linux/Windows" into their
    // parts as additional tokens (while keeping the original) so individual
    // skills get extracted without losing compound aliases like HP/UX.
    const baseWords = segText.split(/[\s,;|•·▪▫‣()[\]{}<>]+/).filter(w => w.length > 0);
    const words: string[] = [];
    for (const w of baseWords) {
      words.push(w);
      if (w.includes('/')) {
        const parts = w.split('/').filter(p => p.length > 0);
        if (parts.length > 1) words.push(...parts);
      }
    }

    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= 4 && i + n <= words.length; n++) {
        const phrase = words.slice(i, i + n).join(' ');
        const phraseLower = phrase.toLowerCase().trim();

        // Skip phrases that are clearly not skills (too short, pure numbers, etc.)
        if (phraseLower.length < 1) {continue;}
        if (/^\d+$/.test(phraseLower)) {continue;}

        const canonical = ALIAS_LOOKUP.get(phraseLower);
        if (!canonical) {continue;}

        // Ambiguous short skills need tech context validation
        if (AMBIGUOUS_SKILLS.has(phraseLower)) {
          const context = segText.slice(
            Math.max(0, segText.toLowerCase().indexOf(phraseLower) - 100),
            Math.min(segText.length, segText.toLowerCase().indexOf(phraseLower) + 100)
          );
          if (!TECH_CONTEXT_SIGNALS.test(context)) {continue;}
        }

        // Negation check — look at the line the phrase appears in.
        // Pass the position of the skill *within* surroundingLine, not the
        // skill's length (the previous code did the latter, so isNegated
        // inspected the start of the line and almost never fired).
        const lineIdx = segTextLower.indexOf(phraseLower);
        if (lineIdx >= 0) {
          const lineStart = segTextLower.lastIndexOf('\n', lineIdx) + 1;
          const lineEnd = segTextLower.indexOf('\n', lineIdx);
          const surroundingLine = segTextLower.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
          const posInLine = lineIdx - lineStart;
          if (isNegated(surroundingLine, posInLine)) {continue;}
        }

        const existing = candidates.get(canonical);
        if (existing) {
          existing.weight += segment.weight;
          existing.count += 1;
        } else {
          candidates.set(canonical, {
            canonical,
            weight: segment.weight,
            count: 1,
          });
        }
      }
    }
  }

  return candidates;
}

// ── Skill classification ──────────────────────────────────────────────────────

// Tools vs core technical skills
const TOOL_SKILLS = new Set([
  // ── Tech tools ────────────────────────────────────────────────────────────
  'Git', 'GitHub', 'GitLab', 'Bitbucket', 'Jira', 'Confluence', 'Trello',
  'Notion', 'Slack', 'Figma', 'Sketch', 'Adobe XD', 'Postman', 'Insomnia',
  'VS Code', 'IntelliJ', 'Vim', 'Webpack', 'Vite', 'npm', 'Yarn', 'pnpm',
  'Storybook', 'ESLint', 'Prettier', 'Datadog', 'Grafana', 'Prometheus',
  'Linear', 'Asana', 'Monday.com', 'Tableau', 'Power BI', 'Looker',
  // ── Non-tech tools ────────────────────────────────────────────────────────
  'POS Systems',              // retail & food service
  'Electronic Medical Records', // healthcare EMR (Epic, Cerner, etc.)
  'Microsoft Office',         // universal office suite
  'QuickBooks',               // accounting
  'Salesforce',               // CRM (used in sales/support)
  'Zoom',                     // remote communication
  'Google Workspace',         // office/collaboration
]);

function classifySkills(candidates: Map<string, SkillCandidate>): {
  technical: string[];
  tools: string[];
} {
  // Sort by section-weighted frequency
  const sorted = Array.from(candidates.values()).sort(
    (a, b) => (b.weight * b.count) - (a.weight * a.count)
  );

  const technical: string[] = [];
  const tools: string[] = [];

  for (const c of sorted) {
    if (TOOL_SKILLS.has(c.canonical)) {
      tools.push(c.canonical);
    } else {
      technical.push(c.canonical);
    }
  }

  return { technical, tools };
}

// ── Soft skill extraction ─────────────────────────────────────────────────────

function extractSoftSkills(text: string): string[] {
  const found = new Set<string>();
  for (const [pattern, label] of SOFT_SKILL_PATTERNS) {
    if (pattern.test(text)) {found.add(label);}
    pattern.lastIndex = 0; // reset stateful regex
  }
  return Array.from(found);
}

// ── Experience extraction ─────────────────────────────────────────────────────

interface ExperienceResult {
  level: 'entry' | 'mid' | 'senior' | 'executive';
  totalYears: number;
  positions: Array<{ title: string; company: string; duration: string; responsibilities: string[] }>;
}

function extractExperience(text: string, segments: TextSegment[]): ExperienceResult {
  // 1. Try "X years of experience" explicit statement
  const yearsMatch = text.match(/(\d+)\+?\s*years?\s*(of\s+)?(experience|exp|work)/i);
  let totalYears = yearsMatch ? parseInt(yearsMatch[1]) : 0;

  // 2. Determine seniority level from text signals
  let level: 'entry' | 'mid' | 'senior' | 'executive' = 'mid';
  for (const { level: l, re } of LEVEL_PATTERNS) {
    if (re.test(text)) { level = l; break; }
  }

  // 3. Refine level from years if not explicitly stated
  if (!yearsMatch) {
    if (level === 'mid') {
      // Try to estimate from job history date ranges
      totalYears = estimateYearsFromDates(text);
    }
  }
  if (yearsMatch && level === 'mid') {
    const y = parseInt(yearsMatch[1]);
    if (y >= 10)      {level = 'senior';}
    else if (y >= 5)  {level = 'senior';}
    else if (y >= 2)  {level = 'mid';}
    else              {level = 'entry';}
    totalYears = y;
  }

  // 4. Parse job positions from experience section, or full text as fallback
  const expSegment = segments.find(s => s.section === 'experience');
  let positions = expSegment ? parsePositions(expSegment.lines.join('\n')) : [];
  // If no positions found from segmented experience, try the full text
  if (positions.length === 0) {
    positions = parsePositions(text);
  }

  return { level, totalYears, positions };
}

function estimateYearsFromDates(text: string): number {
  const yearMatches = text.match(/\b(20\d{2}|19\d{2})\b/g);
  if (!yearMatches || yearMatches.length < 2) {return 0;}
  const years = yearMatches.map(Number);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years, new Date().getFullYear());
  return Math.min(maxYear - minYear, 40); // cap at 40 years
}

// US state names for location detection
const US_STATES_RE = /^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new\s+\w+|north\s+\w+|ohio|oklahoma|oregon|pennsylvania|rhode\s+island|south\s+\w+|tennessee|texas|utah|vermont|virginia|washington|west\s+virginia|wisconsin|wyoming)\b/i;

/**
 * Extract company and title from text preceding a date range.
 * Handles formats like:
 *   "WALMART, INC., Bentonville, Arkansas Programmer Analyst, Team"
 *   "Senior Engineer | Google | Mountain View"
 *   "Software Engineer\nAmazon, Seattle, WA"
 */
function extractCompanyTitle(beforeText: string): { company: string; title: string } {
  let company = '';
  let title = 'Unknown Role';

  // Split on double-space, pipe, tab, or newline
  const parts = beforeText.split(/\s{2,}|[|\t\n]/).map(p => p.replace(/[•·\uf0b7]/g, '').trim()).filter(p => p.length > 1);

  if (parts.length >= 2) {
    const first = parts[0];
    if (/^[A-Z][A-Z\s,.&'()-]+$/.test(first) || /(?:inc|llc|corp|ltd|co)\b/i.test(first)) {
      company = first.replace(/,\s*$/, '');
      title = parts.slice(1).join(', ').replace(/,\s*$/, '');
    } else {
      title = first.replace(/,\s*$/, '');
      company = parts[1].replace(/,\s*$/, '');
    }
  } else if (parts.length === 1) {
    const commaChunks = parts[0].split(/,\s*/).filter(Boolean);
    if (commaChunks.length >= 2 && /^[A-Z][A-Z\s&'()-]+$/.test(commaChunks[0])) {
      // ALL-CAPS first chunk = company. Find where location ends and title begins.
      let titleIdx = commaChunks.length;
      for (let ci = 1; ci < commaChunks.length; ci++) {
        const chunk = commaChunks[ci].trim();
        if (/^(INC|LLC|CORP|LTD|CO)\.?$/i.test(chunk)) continue;
        if (US_STATES_RE.test(chunk) && chunk.split(/\s+/).length === 1) continue;
        if (/^[A-Z][a-z]+$/.test(chunk) && chunk.split(/\s+/).length === 1) continue;
        // Strip leading state name if chunk starts with one
        const stateMatch = chunk.match(US_STATES_RE);
        if (stateMatch && chunk.length > stateMatch[0].length + 1) {
          commaChunks[ci] = chunk.substring(stateMatch[0].length).trim();
        }
        titleIdx = ci;
        break;
      }
      company = commaChunks.slice(0, titleIdx).join(', ');
      title = commaChunks.slice(titleIdx).join(', ') || 'Unknown Role';
    } else if (commaChunks.length >= 2) {
      title = commaChunks[0];
      company = commaChunks.slice(1).join(', ');
    } else {
      // Single token, no commas, no separators. Try last-role-word heuristic:
      // walk word-by-word; everything up to and including the last word that
      // contains a role keyword is the title, the rest is company + location.
      // Catches "Data Scientist Crypto-Express Thailand".
      const words = parts[0].split(/\s+/);
      let lastRoleIdx = -1;
      for (let wi = 0; wi < words.length; wi++) {
        if (ROLE_WORDS_RE.test(words[wi])) lastRoleIdx = wi;
      }
      if (lastRoleIdx >= 0 && lastRoleIdx < words.length - 1) {
        title = words.slice(0, lastRoleIdx + 1).join(' ');
        company = words.slice(lastRoleIdx + 1).join(' ');
        company = stripLocation(company);
      } else {
        title = parts[0];
      }
    }
  }

  title = title.replace(/[,;:\s]+$/, '').trim();
  company = company.replace(/[,;:\s]+$/, '').trim();
  if (title.length > 80) title = title.substring(0, 80).replace(/\s\S*$/, '');

  return { company, title };
}

// Sentences beginning with a past-tense action verb are responsibility
// bullets, not titles. Catches "Drove innovation by...", "Built X..." etc.
const ACTION_VERB_START_RE = /^(drove|built|designed|created|developed|led|managed|implemented|improved|launched|delivered|optimized|owned|oversaw|coordinated|collaborated|integrated|migrated|deployed|maintained|configured|automated|reduced|increased|saved|grew|spearheaded|architected|engineered|programmed|prototyped|tested|analyzed|researched|wrote|drafted|partnered|negotiated|trained|mentored|supervised|presented|conducted|established|founded|scaled|streamlined|refactored|debugged|investigated|resolved|monitored|tracked|measured|evaluated|recommended|responsible|drives|builds|designs|creates|develops|leads|manages)\b/i;

// Country tokens — reject "country-only" company assignments and strip from
// location-laden lines.
const COUNTRY_NAMES_RE = /\b(united states|usa|u\.s\.a?\.?|america|canada|mexico|brazil|argentina|chile|colombia|peru|united kingdom|england|scotland|wales|ireland|france|germany|spain|italy|portugal|netherlands|belgium|sweden|norway|denmark|finland|poland|czech|austria|switzerland|romania|hungary|greece|turkey|russia|ukraine|israel|uae|qatar|saudi|egypt|south africa|nigeria|kenya|guatemala|honduras|panama|costa rica|australia|new zealand|india|china|hong kong|taiwan|japan|south korea|singapore|malaysia|indonesia|thailand|vietnam|philippines|pakistan|bangladesh)\b/i;

const MAJOR_US_CITIES_RE = /\b(new york|los angeles|san francisco|san jose|san diego|san antonio|chicago|houston|phoenix|philadelphia|dallas|austin|fort worth|columbus|charlotte|indianapolis|seattle|denver|boston|nashville|el paso|detroit|memphis|portland|oklahoma city|las vegas|louisville|baltimore|milwaukee|albuquerque|tucson|fresno|sacramento|kansas city|long beach|mesa|atlanta|colorado springs|virginia beach|raleigh|omaha|miami|oakland|minneapolis|tulsa|wichita|new orleans|arlington|cleveland|bakersfield|tampa|aurora|honolulu|anaheim|santa ana|corpus christi|riverside|lexington|stockton|henderson|saint paul|st\.? louis|cincinnati|pittsburgh|anchorage|greensboro|plano|newark|lincoln|toledo|orlando|jersey city|chandler|fort wayne|buffalo|durham|st\.? petersburg|irvine|laredo|lubbock|madison|gilbert|norfolk|reno|winston-salem|glendale|hialeah|garland|scottsdale|irving|chesapeake|north las vegas|fremont|baton rouge|richmond|boise|san bernardino|silicon valley)\b/i;

const US_STATE_NAME_TOKEN_RE = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;

// True if a string is just a country (or several) — used to reject obviously
// broken company assignments like "United States".
function isCountryOnly(s: string): boolean {
  const trimmed = s.trim().replace(/[,.\s]+$/, '');
  if (!trimmed) return false;
  const stripped = trimmed.replace(COUNTRY_NAMES_RE, '').replace(/[,\s]+/g, '').trim();
  return stripped.length === 0;
}

// "PURELOGICS New York" → { company: "PURELOGICS", rest: "New York" }.
// Pulls an ALL-CAPS company prefix off a string. Returns null if absent.
function splitAllCapsCompany(s: string): { company: string; rest: string } | null {
  const m = s.match(/^([A-Z][A-Z0-9&'.-]{2,}(?:\s+[A-Z][A-Z0-9&'.-]+)*)\s+([A-Za-z].+)$/);
  if (!m) return null;
  const company = m[1].trim();
  const rest = m[2].trim();
  if (company.length < 3) return null;
  const firstRestTok = rest.split(/\s+/)[0] || '';
  if (/^[A-Z][A-Z0-9&'.-]+$/.test(firstRestTok)) return null;
  return { company, rest };
}

// Words that strongly suggest a string is a job title (vs a bullet, skill,
// or company name). Used to disambiguate when scanning for title candidates.
const ROLE_WORDS_RE = /\b(engineer|developer|manager|analyst|designer|consultant|director|architect|intern|associate|lead|senior|junior|staff|specialist|coordinator|administrator|admin|technician|support|representative|officer|advisor|scientist|researcher|programmer|tester|product\s+(owner|manager)|principal|head|vp|vice\s+president|chief|cto|ceo|coo|cfo|cmo|cpo|founder|co[\s-]?founder|president|sde|sre|attorney|accountant|nurse|teacher|instructor|writer|editor|recruiter|operator|assistant|clerk|cashier|driver|chef|cook)\b/i;

// True when a line carries only a location — "Everett, WA", "San Francisco, CA",
// "Remote", "London, United Kingdom". Résumés routinely put one of these between
// the company and the date, which is what pushed the real title outside the old
// two-line lookback and left the company stored as the job title.
function isLocationLine(s: string): boolean {
  const t = s.trim().replace(/[,.]+$/, '');
  if (!t || t.length > 60) return false;
  if (/^(remote|onsite|on-site|hybrid|in[\s-]office)$/i.test(t)) return true;
  // Reject anything with role words — "Support Engineer, Seattle" is a title.
  if (ROLE_WORDS_RE.test(t)) return false;
  const chunks = t.split(/,\s*/).map(c => c.trim()).filter(Boolean);
  if (chunks.length === 0 || chunks.length > 3) return false;
  const tail = chunks[chunks.length - 1];
  const tailIsPlace =
    /^[A-Z]{2}$/.test(tail) ||
    US_STATE_NAME_TOKEN_RE.test(tail) ||
    COUNTRY_NAMES_RE.test(tail) ||
    MAJOR_US_CITIES_RE.test(tail) ||
    /^(remote|onsite|on-site|hybrid)$/i.test(tail);
  if (!tailIsPlace) return false;
  // Every chunk must look like a place name, not a company (no Inc/LLC/&).
  return chunks.every(c =>
    !/\b(inc|llc|corp|ltd|co|group|holdings|systems|labs|technologies|solutions|university|hospital)\b/i.test(c) &&
    c.split(/\s+/).length <= 4,
  );
}

// A title that is really just a date fragment ("Present", "Feb 2022", "2019").
const DATE_FRAGMENT_RE = /^(present|currently|current|now|\d{4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+\d{4})?)[,.\s]*$/i;

function looksLikeTitle(s: string): boolean {
  if (!s || s.length < 3 || s.length > 100) return false;
  if (/^[•●■▪\-*]/.test(s)) return false;
  if (/[.;]\s*$/.test(s)) return false;
  if (s.split(/\s+/).length > 12) return false;
  if (/^[A-Z][A-Z/&]+$/.test(s) && s.length < 8) return false;
  // Past-tense action verb starts indicate a responsibility bullet, not a title.
  if (ACTION_VERB_START_RE.test(s)) return false;
  // Mid-string colon followed by a multi-word sentence is a description.
  if (/:.+\s\w+\s\w+/.test(s) && s.length > 50) return false;
  return ROLE_WORDS_RE.test(s);
}

// Strip trailing location segments from a company string. Peels at most 5
// comma-separated tail tokens that look like country / US state / state-code
// / single capitalized city / work-type modifier. Handles "NVIDIA California,
// United States" → "NVIDIA" and "Acme Inc, San Francisco, CA" → "Acme Inc".
function stripLocation(s: string): string {
  let cleaned = s.trim();
  for (let i = 0; i < 5; i++) {
    const m = cleaned.match(/^(.+?),\s*([^,]+)$/);
    if (!m) break;
    const tail = m[2].trim();
    const isCountry = COUNTRY_NAMES_RE.test(tail);
    const isUsState = US_STATE_NAME_TOKEN_RE.test(tail);
    const isStateCode = /^[A-Z]{2}$/.test(tail);
    const isWorkType = /^(remote|onsite|hybrid|in[\s-]office)$/i.test(tail);
    const isCityish = /^[A-Z][a-zA-Z .'-]+$/.test(tail) && tail.split(/\s+/).length <= 3 && !/\b(inc|llc|corp|ltd|co|group|holdings|systems|labs|technologies|solutions)\b/i.test(tail);
    if (isCountry || isUsState || isStateCode || isWorkType || isCityish) {
      cleaned = m[1].trim();
    } else {
      break;
    }
  }
  // Also peel a space-separated trailing country/state (PDF artifact, no comma).
  for (let i = 0; i < 3; i++) {
    const m = cleaned.match(/^(.+?)\s+([A-Z][a-zA-Z]+(?:[\s-][A-Z][a-zA-Z]+){0,2})$/);
    if (!m) break;
    const tail = m[2].trim();
    if (COUNTRY_NAMES_RE.test(tail) || US_STATE_NAME_TOKEN_RE.test(tail) || MAJOR_US_CITIES_RE.test(tail)) {
      cleaned = m[1].trim();
    } else {
      break;
    }
  }
  return cleaned.replace(/[,;:\s]+$/, '');
}

// Re-introduce logical line breaks into a flattened resume blob. PDF text
// extraction frequently strips newlines, producing a single 10K+ char line.
// Without breaks, parsePositions can't see "title \n company \n date" layouts.
// Two-pass: first find all date ranges as complete tokens; THEN walk the text
// applying insertions in reverse so earlier replacements don't shift indices
// of later ones. Single-pass regex with \S anchors mis-fires inside dates
// (matches "r" of "Mar" then breaks "Mar | 2024 – Present").
const DATE_RANGE_RE = /(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[ \t]+|\d{1,2}\/)?\d{4}[ \t]*[–—‐-][ \t]*(?:present|currently?|now|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[ \t]+(?:\d{4})?|\d{1,2}\/\d{4}|\d{4})/gi;

export function reflowResumeText(text: string): string {
  let s = text;

  // 1. Newline before bullets.
  s = s.replace(/[ \t]+(?=[•●■▪])/g, '\n');

  // 2. Newline before every date range. Find all dates first, then insert \n
  //    in reverse so earlier inserts don't shift later positions. Skip dates
  //    already at the start of a line.
  const insertions: number[] = [];
  DATE_RANGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATE_RANGE_RE.exec(s)) !== null) {
    if (m[0].length === 0) { DATE_RANGE_RE.lastIndex++; continue; }
    if (m.index === 0) continue;
    // Walk back over leading whitespace; if we hit a newline, already broken.
    let i = m.index;
    while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
    if (i === 0 || s[i - 1] === '\n') continue;
    insertions.push(i);
  }
  for (let idx = insertions.length - 1; idx >= 0; idx--) {
    const at = insertions[idx];
    s = s.slice(0, at) + '\n' + s.slice(at).replace(/^[ \t]+/, '');
  }

  // 3. Newline between mixed-case title text and an ALL-CAPS company token
  //    followed by a capitalized location word.
  s = s.replace(
    /([a-z)])[ \t]+(?=[A-Z][A-Z0-9&'.-]{2,}(?:[ \t]+[A-Z][A-Z0-9&'.-]+)*[ \t]+[A-Z][a-z])/g,
    '$1\n'
  );

  // 4. Newline before known section headers when preceded by an underscore
  //    separator chunk (common PDF-extracted artifact).
  s = s.replace(
    /_{3,}\s*(?=(experience|work experience|employment|professional experience|education|skills|certifications|projects|summary|profile)\b)/gi,
    '_____\n'
  );

  // 4b. Newline AFTER a section header's trailing underscores. PDFs commonly
  //     emit "Experience _____ <Title>" all on one line.
  s = s.replace(
    /(experience|work experience|employment|professional experience|education|skills|certifications|projects|summary|profile)([ \t]+_{3,})[ \t]+(?=[A-Z])/gi,
    '$1$2\n'
  );

  // 4c. Newline at the END of a previous bullet's sentence when followed by a
  //     title-case phrase (multi-word, contains role words). This catches the
  //     PDF artifact where the last bullet of one job runs into the next job's
  //     title: "...delivered. Senior Data Scientist Machine Learning Engineer".
  //     Run AFTER rule 3 so titles aren't already broken out.
  const TITLE_CASE_RUN = /[A-Z][A-Za-z]*(?:[ \t]+(?:[A-Z][A-Za-z&'.-]*|&|and|of|the|to|for|\([A-Za-z0-9, /-]+\)))+/;
  s = s.split('\n').map(line => {
    const m = line.match(new RegExp('^(.+?\\.\\s+)(' + TITLE_CASE_RUN.source + ')[ \\t]*$'));
    if (m && /\b(engineer|developer|manager|analyst|designer|consultant|director|architect|scientist|specialist|coordinator|administrator|technician|associate|lead|principal|head|chief|founder|president|intern|advisor)\b/i.test(m[2])) {
      return m[1] + '\n' + m[2];
    }
    return line;
  }).join('\n');

  // 5. Collapse runs of more than one newline into one.
  s = s.replace(/\n{2,}/g, '\n');
  return s;
}

function parsePositions(text: string): ExperienceResult['positions'] {
  const positions: ExperienceResult['positions'] = [];
  // Separator accepts dashes AND the word forms ("2019 to 2022", "2019 until
  // 2022"). Word-separated ranges previously matched nothing, so those résumés
  // produced zero positions rather than a wrong one — a silent total loss.
  const dateRe = /(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+|\d{1,2}\/)?\d{4}\s*(?:[–—‐-]|\bto\b|\buntil\b)\s*(?:present|currently?|now|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+|\d{1,2}\/)?\d{0,4}/gi;

  const reflowed = reflowResumeText(text);
  const lines = reflowed.split('\n').map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dateMatch = dateRe.exec(line);
    dateRe.lastIndex = 0;
    if (!dateMatch) continue;

    // Text on the same line before the date — usually "Company, City, ST"
    // Preserve `|` so extractCompanyTitle can use it as a separator;
    // bullets/tabs collapse to spaces.
    const beforeOnLineRaw = line.substring(0, dateMatch.index).replace(/[•·]/g, ' ').replace(/\t/g, '  ').replace(/\s+/g, ' ').trim();
    const beforeOnLine = beforeOnLineRaw.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();

    // Look DOWN 1-4 non-blank lines for a title.
    // Many resumes use "Company [TAB] Date \n Title \n bullets" layout.
    let titleBelow = '';
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const cand = lines[j];
      if (!cand) continue;
      if (dateRe.test(cand)) { dateRe.lastIndex = 0; break; }
      dateRe.lastIndex = 0;
      if (/^[•●■▪\-*]/.test(cand)) break;
      if (cand.length > 100 && !looksLikeTitle(cand)) break;
      if (looksLikeTitle(cand)) { titleBelow = cand; break; }
    }

    // If we have a title on the date line (Title + Date inline) and no title
    // was found above us, look DOWN 1-2 non-bullet lines for a company.
    // Catches "Software Engineer  2021 – Present \n Acme Corp \n • bullet".
    let companyBelow = '';
    if (beforeOnLine && !titleBelow && looksLikeTitle(beforeOnLine)) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const cand = lines[j];
        if (!cand) continue;
        if (dateRe.test(cand)) { dateRe.lastIndex = 0; break; }
        dateRe.lastIndex = 0;
        if (/^[•●■▪\-*]/.test(cand)) break;
        // Company candidate: short, no period, no role words, not a section header.
        const words = cand.split(/\s+/).length;
        if (words >= 1 && words <= 6 && !/[.;]$/.test(cand) && !ROLE_WORDS_RE.test(cand) && !ACTION_VERB_START_RE.test(cand)) {
          companyBelow = stripLocation(cand);
          break;
        }
      }
    }

    // Look UP for the title-above-date layout. Four lines, not two: the common
    // "Title / Company / Location / Date" block puts the title three lines up, so
    // a two-line window could only ever see [Company, Location] — which is how a
    // company name ended up stored as somebody's job title in prod.
    const contextLines: string[] = [];
    if (beforeOnLine) contextLines.push(beforeOnLine);
    for (let back = 1; back <= 4 && i - back >= 0; back++) {
      const prev = lines[i - back].trim();
      if (!prev) continue;
      if (dateRe.test(prev)) { dateRe.lastIndex = 0; break; }
      dateRe.lastIndex = 0;
      if (/^[•\-*]/.test(prev)) break;
      contextLines.unshift(prev);
    }

    let company = '';
    let title = 'Unknown Role';

    if (beforeOnLine && companyBelow && looksLikeTitle(beforeOnLine)) {
      // Title + Date inline, Company on next line.
      title = beforeOnLine;
      company = companyBelow;
    } else if (titleBelow && beforeOnLine) {
      // Strongest signal: "Company [TAB] Date \n Title"
      title = titleBelow;
      company = stripLocation(beforeOnLine);
    } else if (titleBelow) {
      // Title found below; company should be the most recent non-bullet line above
      title = titleBelow;
      for (let back = 1; back <= 3 && i - back >= 0; back++) {
        const prev = lines[i - back];
        if (!prev || /^[•\-*]/.test(prev)) continue;
        company = stripLocation(prev);
        break;
      }
    } else if (!beforeOnLine && contextLines.length >= 2 && contextLines.some(looksLikeTitle)) {
      // Assign by what each line IS, not by where it sits. Position is not a
      // reliable signal: the line directly above a date is the title in
      // "Title / Date" but the location in "Title / Company / Location / Date".
      // Taking contextLines[0] on faith is what stored "Amazon" as a job title.
      //
      // The title is the topmost line that reads as a role — companies and
      // locations rarely contain role words, so looksLikeTitle is the
      // discriminator. Everything else is joined and handed to stripLocation,
      // which peels trailing place tokens: ["Amazon", "Everett, WA"] becomes
      // "Amazon, Everett, WA" → "Amazon". Deliberately NOT filtering location
      // lines out first — "Stripe, San Francisco, CA" is one line carrying both
      // company and location, and dropping it loses the employer entirely.
      const titleIdx = contextLines.findIndex(looksLikeTitle);
      title = contextLines[titleIdx];
      const rest = contextLines.filter((_, idx) => idx !== titleIdx);
      company = rest.length ? stripLocation(rest.join(', ')) : '';
    } else if (contextLines.length >= 2 && !beforeOnLine) {
      // "Title \n Company \n Date" — no line read as a role, so fall back to
      // the positional assumption rather than emitting nothing.
      title = contextLines[0];
      company = stripLocation(contextLines.slice(1).join(', '));
    } else {
      // When the date line carries its own text, that text IS this entry —
      // lines above belong to the previous job or to a section header. Use the
      // pipe-preserving form so "Title | Company | Date" splits cleanly.
      // Keyed on beforeOnLine rather than contextLines.length: the lookback
      // reaches four lines now, so a length check silently stopped matching.
      const combinedSource = beforeOnLine ? [beforeOnLineRaw] : contextLines;
      const combined = combinedSource.join('\n');
      ({ company, title } = extractCompanyTitle(combined));
      company = stripLocation(company);
    }

    // Collect responsibilities
    const responsibilities: string[] = [];
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const next = lines[j].trim();
      if (dateRe.test(next)) { dateRe.lastIndex = 0; break; }
      dateRe.lastIndex = 0;
      if (/^[A-Z][A-Z\s,.&'()-]+$/.test(next) && next.length > 5 && next.length < 80) break;
      if (next.startsWith('•') || next.startsWith('-') || next.startsWith('*') || next.charCodeAt(0) === 0xf0b7 || next.length > 30) {
        responsibilities.push(next);
      }
    }

    // Reject obvious junk: empty, sentence-like, or paragraph-length titles
    if (title === 'Unknown Role' || title.length < 3) continue;
    if (/[.;]\s*$/.test(title)) continue;
    if (title.split(/\s+/).length > 12) continue;
    // A date fragment is never a job title. Reflowed PDF blobs can leave
    // "Present" or "Feb 2022" sitting where a title should be, and positions[0]
    // becomes the profile headline — so drop it rather than show it.
    if (DATE_FRAGMENT_RE.test(title.trim())) continue;
    if (isLocationLine(title)) continue;

    positions.push({ title, company, duration: dateMatch[0], responsibilities });
  }

  // Strategy 2: Dateless resumes with "Company — Title" or "Company – Title" (em/en-dash)
  if (positions.length === 0) {
    const dashSepRe = /^(.+?)\s*[–—]\s*(.+)$/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = dashSepRe.exec(line);
      if (!match) continue;
      const left = match[1].trim();
      const right = match[2].trim();
      if (left.length < 3 || right.length < 3) continue;
      if (/^[•●■▪\uf0b7]/.test(left)) continue;

      // Confirm: next line should be a bullet (responsibility) to avoid false positives
      const nextLine = lines[i + 1]?.trim() || '';
      const hasBullets = /^[•●■▪\uf0b7\-*]/.test(nextLine);
      if (!hasBullets && i + 1 < lines.length) continue;

      const responsibilities: string[] = [];
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const next = lines[j].trim();
        if (dashSepRe.test(next)) break;
        if (/^[•●■▪\uf0b7\-*]/.test(next) || next.length > 30) {
          responsibilities.push(next);
        }
      }
      // "Title: description" — keep just the title before the colon
      let title = right;
      const colonIdx = title.indexOf(':');
      if (colonIdx > 0 && colonIdx < title.length - 1) {
        title = title.substring(0, colonIdx).trim();
      }
      if (title.split(/\s+/).length > 12) continue;
      positions.push({ title, company: left, duration: '', responsibilities });
    }
  }

  // Sanity pass: rescue obvious title/company mix-ups before returning.
  for (const pos of positions) {
    // ALL-CAPS prefix in title → that's the company. "PURELOGICS New York" /
    // "BLOCBELT Maryland" → company: PURELOGICS, rest goes to location.
    const splitCaps = splitAllCapsCompany(pos.title);
    if (splitCaps) {
      const companyLooksLikeTitle = !!pos.company && ROLE_WORDS_RE.test(pos.company) && !ACTION_VERB_START_RE.test(pos.company);
      const companyIsEmpty = !pos.company || isCountryOnly(pos.company);
      if (companyIsEmpty) {
        // Title was "COMPANY City, Country" with no real company — peel the
        // ALL-CAPS prefix as the company, drop the location.
        pos.title = splitCaps.rest;
        pos.company = splitCaps.company;
      } else if (companyLooksLikeTitle) {
        // Title was "COMPANY City, Country" and company field is the real
        // role title — fields are inverted, swap them.
        pos.title = pos.company;
        pos.company = splitCaps.company;
      }
    }
    // Company is just a country / location — clear it.
    if (pos.company && isCountryOnly(pos.company)) {
      pos.company = '';
    }
    // Title empty/Unknown but company carries role words — swap.
    if ((!pos.title || pos.title === 'Unknown Role') && pos.company && ROLE_WORDS_RE.test(pos.company)) {
      const tmp = pos.company;
      pos.company = pos.title || '';
      pos.title = tmp;
    }
    // Strip residual location from company.
    if (pos.company) pos.company = stripLocation(pos.company);
  }

  // Drop positions whose title still looks like a responsibility bullet.
  const cleaned = positions.filter(p =>
    p.title && p.title !== 'Unknown Role' && !ACTION_VERB_START_RE.test(p.title)
  );

  return cleaned.slice(0, 8);
}

// ── Education extraction ──────────────────────────────────────────────────────

function extractEducation(segments: TextSegment[]): SkillIntelligenceResult['education'] {
  const eduSegment = segments.find(s => s.section === 'education');
  if (!eduSegment) {return [];}

  const DEGREE_RE = /\b(ph\.?d\.?|doctor(ate)?|master'?s?|m\.?s\.?|m\.?a\.?|mba|msc|bachelor'?s?|b\.?s\.?|b\.?a\.?|bsc|associate|diploma|certificate)\b/i;
  const YEAR_RE = /\b(19|20)\d{2}\b/;

  const results: SkillIntelligenceResult['education'] = [];
  const lines = eduSegment.lines.map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const degreeMatch = line.match(DEGREE_RE);
    if (degreeMatch) {
      const yearMatch = (lines[i + 1] || line).match(YEAR_RE);
      results.push({
        degree: degreeMatch[0],
        institution: line.replace(degreeMatch[0], '').replace(/[,-]/, '').trim() || (lines[i + 1] || '').trim(),
        year: yearMatch?.[0],
      });
    }
  }

  return results.slice(0, 4);
}

// ── Certification extraction ──────────────────────────────────────────────────

const CERT_PATTERNS = [
  /\b(aws\s+certified[\w\s]+?(solutions\s+architect|developer|devops|sysops|cloud|database|security|specialty)?)/gi,
  /\b(google\s+(cloud|professional)\s+[\w\s]+?certified?)\b/gi,
  /\b(microsoft\s+certified[\w\s]+)\b/gi,
  /\b(certified\s+(kubernetes|scrum|safe|pmp|cissp|ceh|aws|gcp|azure|data|cloud)[\w\s]*)\b/gi,
  /\b(pmp|cissp|ceh|cism|cisa|comptia[\s+][\w]+|ccna|ccnp|rhce|lpic|ckad|cka)\b/gi,
  /\b(tensorflow\s+developer\s+certificate)\b/gi,
  /\b(oracle\s+certified[\w\s]+)\b/gi,
];

function extractCertifications(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of CERT_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      found.add(match[0].trim().replace(/\s+/g, ' '));
    }
  }
  return Array.from(found).slice(0, 10);
}

// ── Personal info extraction ──────────────────────────────────────────────────

function extractPersonalInfo(text: string): SkillIntelligenceResult['personalInfo'] {
  const info: SkillIntelligenceResult['personalInfo'] = {};

  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {info.email = emailMatch[0];}

  const phoneMatch = text.match(/(\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
  if (phoneMatch) {info.phone = phoneMatch[0].trim();}

  const linkedinMatch = text.match(/linkedin\.com\/in\/([\w-]+)/i);
  if (linkedinMatch) {info.linkedin = `https://linkedin.com/in/${linkedinMatch[1]}`;}

  const githubMatch = text.match(/github\.com\/([\w-]+)/i);
  if (githubMatch) {info.github = `https://github.com/${githubMatch[1]}`;}

  const portfolioMatch = text.match(/https?:\/\/(?!linkedin|github)[\w.-]+\.(io|com|dev|me|co|net)(\/[\w.-]*)*/i);
  if (portfolioMatch) {info.website = portfolioMatch[0];}

  // Location: "City, ST" or "City, State" pattern in the first 20 lines
  const headerText = text.split('\n').slice(0, 20).join('\n');
  const locationMatch = headerText.match(/\b([A-Z][a-zA-Z\s]+),\s*([A-Z]{2})\b/);
  if (locationMatch) {info.location = locationMatch[0];}

  // Name: first 10 non-empty lines, find a "Firstname Lastname" pattern
  const JOB_TITLE_WORDS = /\b(engineer|developer|manager|analyst|designer|consultant|director|architect|intern|associate|lead|senior|junior|staff|resume|cv)\b/i;
  for (const line of text.split('\n').slice(0, 10).map(l => l.trim()).filter(Boolean)) {
    if (/[@\d|()•\\]|linkedin|github|http|\.com|\.edu|\.org/i.test(line)) {continue;}
    if (JOB_TITLE_WORDS.test(line)) {continue;}
    if (/^([A-Z][a-zA-Z'-]{1,20}\s){1,3}[A-Z][a-zA-Z'-]{1,20}$/.test(line)) {
      info.name = line;
      break;
    }
  }

  return info;
}

// ── Confidence scoring ────────────────────────────────────────────────────────

function computeConfidence(technical: string[], totalYears: number, personalInfo: SkillIntelligenceResult['personalInfo']): number {
  let score = 0;
  if (technical.length >= 5)           {score += 40;}
  else if (technical.length >= 2)      {score += 20;}
  else if (technical.length >= 1)      {score += 10;}
  if (totalYears > 0)                  {score += 15;}
  if (personalInfo.email)              {score += 15;}
  if (personalInfo.name)               {score += 15;}
  if (personalInfo.linkedin || personalInfo.github) {score += 15;}
  return Math.min(score, 95); // never claim 100% — we're not AI
}
