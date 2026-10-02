/**
 * Shared job scoring module — single source of truth for all matching logic.
 *
 * Blends keyword matching, semantic embedding similarity, and job title/role
 * relevance. All scoring is synchronous — no API calls on the request path.
 *
 * Score weights:
 *   Semantic embedding:   35%  (primary signal — pgvector retrieval)
 *   Keyword skill match:  25%  (precision signal)
 *   Title/role relevance: 25%
 *   Experience level:     15%
 *   Context bonus:        +0-8 points (location + work type, additive)
 *
 * Hard caps:
 *   - No skill overlap AND no role family match:
 *     With semantic signal → capped at 45% (lets strong semantic matches through)
 *     Without semantic signal → capped at 25% (prevents noise)
 */

import { parseSkillsInput, getRelatedSkills } from './skill-normalizer';
import { extractSkillsFromText } from './utils/skill-extractor';
import { cosineSimilarity } from './ml-matching';

// ── Learned weights (loaded from DB, refreshed every 10min) ──────────

interface LearnedWeights { keyword: number; semantic: number; title: number; experience: number }
let _cachedWeights: LearnedWeights | null = null;
let _weightsLoadedAt = 0;
const WEIGHTS_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Load learned weights from DB if available. Non-blocking — returns cached
 * value if fresh, triggers async refresh otherwise. Falls back to defaults.
 */
function getWeights(): LearnedWeights {
  const defaults: LearnedWeights = { keyword: 0.25, semantic: 0.35, title: 0.25, experience: 0.15 };

  // Trigger async refresh if stale
  if (Date.now() - _weightsLoadedAt > WEIGHTS_TTL) {
    _weightsLoadedAt = Date.now(); // prevent thundering herd
    import('./services/match-signals.service').then(mod =>
      mod.getLearnedWeights().then(w => {
        if (w) _cachedWeights = w;
      })
    ).catch(() => {});
  }

  return _cachedWeights || defaults;
}

// ── Types ──────────────────────────────────────────────────────────

export interface JobLike {
  title?: string | null;
  description?: string | null;
  skills?: string[] | null;
  vectorEmbedding?: string | null;
  embeddingUpdatedAt?: Date | null;
  location?: string | null;
  workType?: string | null;
}

export interface CandidateContext {
  location?: string | null;
  workType?: string | null;
}

export interface JobScore {
  matchScore: number;
  matchTier: 'great' | 'good' | 'worth-a-look';
  skillMatches: string[];
  partialSkillMatches: string[];
  aiExplanation: string;
  confidenceLevel: number;
  // Component scores for signal capture / feedback loop
  components: {
    keywordScore: number;
    semanticScore: number;
    titleScore: number;
    experienceScore: number;
    contextBonus: number;
    hasSemanticSignal: boolean;
  };
}

// ── Role family extraction ─────────────────────────────────────────

const ROLE_FAMILIES: Array<[RegExp, string]> = [
  // IT / Support / Helpdesk
  [/(?:it support|help\s*desk|desktop support|technical support|support (?:engineer|specialist|technician|analyst))/i, 'it_support'],
  [/(?:system(?:s)?\s*admin|sysadmin)/i, 'systems_admin'],
  [/(?:network\s*(?:engineer|admin|technician))/i, 'network_engineer'],
  [/(?:database\s*admin|dba)/i, 'dba'],
  // Data
  [/data\s*scientist/i, 'data_scientist'],
  [/data\s*engineer/i, 'data_engineer'],
  [/data\s*analyst/i, 'data_analyst'],
  [/(?:machine\s*learning|ml)\s*engineer/i, 'ml_engineer'],
  // DevOps / Cloud / Infra
  [/(?:devops|site\s*reliability|sre)/i, 'devops'],
  [/cloud\s*(?:engineer|architect)/i, 'cloud_engineer'],
  [/(?:security\s*engineer|cybersecurity|infosec|soc\s*analyst)/i, 'security_engineer'],
  // QA
  [/(?:qa|quality\s*assurance|test\s*engineer|sdet)/i, 'qa_engineer'],
  // Mobile
  [/(?:mobile|ios|android)\s*(?:developer|engineer)/i, 'mobile_developer'],
  // Web / Full-stack
  [/(?:frontend|front[\s-]end)/i, 'frontend_developer'],
  [/(?:backend|back[\s-]end)/i, 'backend_developer'],
  [/full[\s.-]*stack/i, 'fullstack_developer'],
  [/software\s*(?:engineer|developer)/i, 'software_engineer'],
  [/web\s*developer/i, 'web_developer'],
  // Product / Design
  [/product\s*manager/i, 'product_manager'],
  [/product\s*designer/i, 'product_designer'],
  [/(?:ux|ui|ux\/ui)\s*designer/i, 'ux_designer'],
  [/graphic\s*designer/i, 'graphic_designer'],
  // Management
  [/engineering\s*manager/i, 'engineering_manager'],
  [/project\s*manager/i, 'project_manager'],
  [/program\s*manager/i, 'program_manager'],
  [/scrum\s*master/i, 'scrum_master'],
  // Business / Analysis
  [/business\s*analyst/i, 'business_analyst'],
  [/solutions?\s*architect/i, 'solutions_architect'],
  [/technical\s*writer/i, 'technical_writer'],
  // Legal / Finance / HR — distinct families that should NOT cross-match with tech
  [/(?:general\s*counsel|lawyer|attorney|legal\s*(?:counsel|advisor|officer))/i, 'legal'],
  [/(?:accountant|controller|cfo|finance\s*(?:manager|director|analyst))/i, 'finance'],
  [/(?:hr\s*(?:manager|director|partner|generalist)|human\s*resources|recruiter|talent\s*acquisition)/i, 'hr'],
  [/(?:marketing\s*(?:manager|director|specialist)|growth\s*(?:manager|lead)|brand\s*manager)/i, 'marketing'],
  [/(?:sales\s*(?:manager|director|rep|executive|engineer)|account\s*executive|bdr|sdr)/i, 'sales'],
  [/(?:operations\s*(?:manager|director)|office\s*manager|facilities)/i, 'operations'],
  // Healthcare — kept distinct from tech so cross-domain mismatches get
  // capped by the role-mismatch gate in scoreJob.
  [/(?:(?:registered|charge|staff|travel|per\s*diem|critical\s*care|emergency|operating\s*room|pediatric|psychiatric|home\s*health|hospice|telemetry|icu|er|or)\s*nurse|nurse\s*(?:manager|practitioner|supervisor|coordinator|anesthetist|midwife|educator)|nursing\s*(?:assistant|aide|supervisor|director)|certified\s*nursing\s*assistant|\b(?:rn|lpn|lvn|cna|crna)\b|nurse\s*practitioner|\bnurse\b)/i, 'nursing'],
  [/(?:\bphysician\b|\bsurgeon\b|medical\s*doctor|resident\s*physician|attending\s*physician|cardiologist|oncologist|radiologist|pediatrician|psychiatrist|anesthesiologist|dermatologist|neurologist|gynecologist|emergency\s*medicine\s*physician|family\s*medicine\s*physician|internal\s*medicine\s*physician)/i, 'physician'],
  [/(?:physical\s*therapist|occupational\s*therapist|respiratory\s*therapist|speech(?:[\s-]language)?\s*pathologist|\bemt\b|paramedic|medical\s*(?:assistant|technician|technologist|laboratory\s*tech|lab\s*tech)|pharmacy\s*(?:technician|tech)|\bpharmacist\b|dental\s*(?:hygienist|assistant)|\bdentist\b|radiology\s*(?:technician|technologist)|surgical\s*(?:technician|technologist)|sonographer|phlebotomist|x[\s-]?ray\s*tech|\bdietitian\b|nutritionist|chiropractor|optometrist|podiatrist|audiologist)/i, 'allied_health'],
  [/(?:psychologist|psychotherapist|\b(?:lcsw|lpc|lmft|msw)\b|licensed\s*(?:clinical|professional|marriage)\s*(?:counselor|therapist|social\s*worker)|mental\s*health\s*counselor|substance\s*abuse\s*counselor|behavioral\s*health\s*(?:counselor|specialist)|marriage\s*and\s*family\s*therapist|family\s*therapist|art\s*therapist|school\s*counselor|guidance\s*counselor|social\s*worker)/i, 'mental_health'],
  // Education
  [/(?:(?:elementary|middle\s*school|high\s*school|secondary|preschool|kindergarten|special\s*education|esl|substitute)\s*teacher|\bteacher\b|\bprofessor\b|adjunct(?:\s*professor)?|\blecturer\b|teaching\s*assistant|tutor|principal|vice\s*principal|dean\s*of|department\s*chair|education\s*(?:director|coordinator)|curriculum\s*(?:designer|developer|specialist))/i, 'education'],
  // Food service / hospitality
  [/(?:\bchef\b|sous\s*chef|line\s*cook|prep\s*cook|pastry\s*chef|executive\s*chef|head\s*cook|\bcook\b|kitchen\s*manager|barista|bartender|\bwaiter\b|waitress|food\s*service|fast\s*food\s*(?:worker|crew)|cocktail\s*server|cafeteria\s*worker|dishwasher|host(?:ess)?\s*(?:restaurant)?)/i, 'food_service'],
  [/(?:hotel\s*manager|front\s*desk\s*(?:agent|clerk|associate)|\bconcierge\b|housekeeping|housekeeper|bellhop|bellman|guest\s*services|reservations\s*agent|hospitality\s*(?:manager|coordinator)|innkeeper|resort\s*manager|banquet\s*(?:manager|server)|event\s*coordinator)/i, 'hospitality'],
  // Retail / customer service
  [/(?:retail\s*(?:associate|sales|manager|supervisor)|sales\s*associate|store\s*(?:manager|associate|clerk|supervisor)|\bcashier\b|merchandiser|stock\s*(?:clerk|associate)|sales\s*floor|key\s*holder|assistant\s*store\s*manager|department\s*lead)/i, 'retail'],
  [/(?:customer\s*service\s*(?:representative|rep|associate|specialist|manager)|\bcsr\b|call\s*center\s*(?:agent|representative|rep|operator)|customer\s*support\s*(?:representative|specialist|associate)|client\s*(?:services|relations)\s*(?:representative|associate|specialist)|service\s*advisor|claims\s*representative)/i, 'customer_service'],
  // Skilled trades
  [/(?:\belectrician\b|journeyman\s*electrician|master\s*electrician|\bplumber\b|hvac\s*(?:technician|tech|installer)|\bwelder\b|carpenter|machinist|millwright|pipefitter|sheet\s*metal|locksmith|glazier|roofer|drywaller|\bmason\b)/i, 'skilled_trades'],
  [/(?:auto(?:motive)?\s*(?:mechanic|technician)|diesel\s*(?:mechanic|technician)|aircraft\s*mechanic|maintenance\s*(?:technician|mechanic)|small\s*engine\s*mechanic|industrial\s*mechanic|fleet\s*mechanic|\bmechanic\b)/i, 'mechanic'],
  [/(?:(?:production|assembly|manufacturing|factory|plant)\s*(?:worker|operator|technician|associate|supervisor|lead)|machine\s*operator|cnc\s*operator|forklift\s*operator|quality\s*(?:control|inspector)\s*technician|production\s*line)/i, 'manufacturing'],
  [/(?:construction\s*(?:worker|laborer|foreman|superintendent|manager|supervisor)|construction\s*project\s*manager|\bforeman\b|general\s*laborer|construction\s*estimator|building\s*inspector|site\s*superintendent|crane\s*operator|heavy\s*equipment\s*operator|concrete\s*finisher)/i, 'construction'],
  // Transportation / logistics
  [/(?:truck\s*driver|cdl\s*driver|delivery\s*driver|bus\s*driver|taxi\s*driver|rideshare\s*driver|courier|chauffeur|owner[\s-]?operator|shuttle\s*driver)/i, 'driver'],
  [/(?:warehouse\s*(?:associate|worker|manager|supervisor|lead|clerk)|fulfillment\s*(?:associate|worker|specialist)|order\s*picker|\bpicker\b|\bpacker\b|shipping\s*(?:clerk|associate)|receiving\s*(?:clerk|associate)|inventory\s*(?:clerk|specialist|associate))/i, 'warehouse'],
  [/(?:logistics\s*(?:coordinator|manager|specialist|analyst)|\bdispatcher\b|fleet\s*(?:manager|coordinator)|supply\s*chain\s*(?:coordinator|analyst|specialist|manager)|transportation\s*(?:coordinator|manager))/i, 'logistics'],
  // Creative / media
  [/(?:\bcopywriter\b|content\s*(?:writer|creator|specialist|strategist)|\bjournalist\b|\breporter\b|(?:content|copy|news|book|magazine|video|managing|associate)\s*editor|editor[\s-]?in[\s-]?chief|grant\s*writer|freelance\s*writer|staff\s*writer|\bauthor\b)/i, 'creative_writer'],
  [/(?:photographer|videographer|video\s*editor|video\s*producer|cinematographer|director\s*of\s*photography|camera\s*operator|film\s*editor|motion\s*graphics(?:\s*designer)?|animator)/i, 'video_creative'],
  [/(?:illustrator|fine\s*artist|art\s*director|creative\s*director|visual\s*artist)/i, 'artist'],
  // Administrative
  [/(?:executive\s*(?:assistant|admin)|administrative\s*(?:assistant|coordinator|specialist|aide)|admin\s*assistant|office\s*(?:assistant|coordinator|administrator)|\bsecretary\b|\breceptionist\b|data\s*entry\s*(?:clerk|specialist|operator)|file\s*clerk|virtual\s*assistant)/i, 'administrative'],
  // Note: previously had generic fallbacks (analyst/designer/engineer/developer/
  // manager/architect) here. They matched any title containing those tokens —
  // including parser-extracted junk like sentence fragments — and expanded to
  // single broad keywords that polluted retrieval (e.g. "engineer" matching
  // every Mechanical/Manufacturing/Structures Engineer for a UX candidate).
  // Returning null for non-specific titles is safer than over-matching.
];

function extractRoleFamily(title: string): string | null {
  for (const [pattern, family] of ROLE_FAMILIES) {
    if (pattern.test(title)) return family;
  }
  return null;
}

/**
 * Map of related role families that get partial credit (0.5x).
 * Explicitly excludes cross-domain matches (legal, finance, hr, etc.)
 */
const RELATED_ROLE_FAMILIES: Record<string, string[]> = {
  software_engineer: ['software_developer', 'fullstack_developer', 'backend_developer', 'frontend_developer', 'web_developer', 'developer', 'engineer'],
  software_developer: ['software_engineer', 'fullstack_developer', 'backend_developer', 'frontend_developer', 'web_developer', 'developer', 'engineer'],
  fullstack_developer: ['software_engineer', 'software_developer', 'backend_developer', 'frontend_developer', 'web_developer'],
  frontend_developer: ['software_engineer', 'software_developer', 'fullstack_developer', 'web_developer', 'ux_designer'],
  backend_developer: ['software_engineer', 'software_developer', 'fullstack_developer', 'devops'],
  web_developer: ['software_engineer', 'software_developer', 'fullstack_developer', 'frontend_developer'],
  mobile_developer: ['software_engineer', 'software_developer', 'frontend_developer'],
  data_scientist: ['data_analyst', 'ml_engineer', 'data_engineer'],
  data_engineer: ['data_scientist', 'data_analyst', 'backend_developer', 'devops'],
  data_analyst: ['data_scientist', 'business_analyst', 'analyst'],
  ml_engineer: ['data_scientist', 'data_engineer', 'software_engineer'],
  devops: ['cloud_engineer', 'systems_admin', 'backend_developer'],
  cloud_engineer: ['devops', 'systems_admin', 'solutions_architect'],
  systems_admin: ['devops', 'cloud_engineer', 'network_engineer', 'it_support'],
  network_engineer: ['systems_admin', 'devops', 'cloud_engineer', 'it_support'],
  it_support: ['systems_admin', 'network_engineer'],
  security_engineer: ['devops', 'systems_admin', 'network_engineer', 'engineer'],
  product_manager: ['program_manager', 'project_manager'],
  product_designer: ['ux_designer', 'graphic_designer', 'designer'],
  ux_designer: ['product_designer', 'graphic_designer', 'frontend_developer', 'designer'],
  engineering_manager: ['software_engineer', 'manager'],
  project_manager: ['program_manager', 'product_manager', 'scrum_master'],
  qa_engineer: ['software_engineer', 'developer'],
  solutions_architect: ['cloud_engineer', 'architect', 'software_engineer'],
  dba: ['data_engineer', 'backend_developer', 'systems_admin'],
  // Non-tech families — only relate to each other, never to tech roles
  legal: [],
  finance: [],
  hr: ['recruiter', 'administrative'],
  marketing: ['sales'],
  sales: ['marketing'],
  operations: [],
  // Healthcare cluster — clinical roles relate within healthcare only
  nursing: ['allied_health'],
  physician: ['allied_health'],
  allied_health: ['nursing', 'physician'],
  mental_health: [],
  // Education
  education: [],
  // Hospitality cluster
  food_service: ['hospitality'],
  hospitality: ['food_service'],
  // Retail / customer service
  retail: ['customer_service'],
  customer_service: ['retail', 'administrative'],
  // Trades / industrial cluster
  skilled_trades: ['mechanic', 'manufacturing', 'construction'],
  mechanic: ['skilled_trades', 'manufacturing'],
  manufacturing: ['skilled_trades', 'warehouse'],
  construction: ['skilled_trades'],
  // Transportation / logistics
  driver: ['warehouse', 'logistics'],
  warehouse: ['driver', 'manufacturing', 'logistics'],
  logistics: ['driver', 'warehouse'],
  // Creative / media
  creative_writer: ['video_creative'],
  video_creative: ['artist', 'creative_writer'],
  artist: ['video_creative'],
  // Administrative
  administrative: ['hr', 'customer_service'],
};

/**
 * Given candidate's previous job titles, return title keywords for DB retrieval.
 * Expands role families into searchable terms so the DB query pulls jobs
 * the scorer can evaluate — even when skill tags don't overlap.
 *
 * Example: "IT Support Specialist" → ["it support", "help desk", "desktop support",
 *   "technical support", "support engineer", "system admin", "network engineer"]
 */
const ROLE_FAMILY_KEYWORDS: Record<string, string[]> = {
  it_support: ['it support', 'help desk', 'desktop support', 'technical support', 'support specialist', 'support technician', 'support analyst', 'support engineer'],
  systems_admin: ['system admin', 'sysadmin', 'systems engineer', 'infrastructure'],
  network_engineer: ['network engineer', 'network admin', 'network technician'],
  dba: ['database admin', 'dba', 'database engineer'],
  data_scientist: ['data scientist', 'data science'],
  data_engineer: ['data engineer', 'data pipeline', 'data platform'],
  data_analyst: ['data analyst', 'business intelligence', 'bi analyst'],
  ml_engineer: ['machine learning', 'ml engineer', 'ai engineer'],
  devops: ['devops', 'site reliability', 'sre', 'platform engineer'],
  cloud_engineer: ['cloud engineer', 'cloud architect', 'aws engineer', 'azure engineer'],
  security_engineer: ['security engineer', 'cybersecurity', 'infosec', 'soc analyst', 'security analyst'],
  qa_engineer: ['qa engineer', 'quality assurance', 'test engineer', 'sdet', 'qa analyst'],
  mobile_developer: ['mobile developer', 'ios developer', 'android developer', 'mobile engineer'],
  frontend_developer: ['frontend', 'front-end', 'front end', 'ui developer', 'ui engineer'],
  backend_developer: ['backend', 'back-end', 'back end', 'server engineer'],
  fullstack_developer: ['full stack', 'fullstack'],
  software_engineer: ['software engineer', 'software developer', 'swe'],
  web_developer: ['web developer', 'web engineer'],
  product_manager: ['product manager', 'product owner'],
  product_designer: ['product designer'],
  ux_designer: ['ux designer', 'ui designer', 'ux/ui', 'interaction designer'],
  graphic_designer: ['graphic designer', 'visual designer'],
  engineering_manager: ['engineering manager', 'dev manager'],
  project_manager: ['project manager', 'project coordinator'],
  program_manager: ['program manager', 'tpm', 'technical program'],
  scrum_master: ['scrum master', 'agile coach'],
  business_analyst: ['business analyst', 'business systems'],
  solutions_architect: ['solutions architect', 'solution architect', 'enterprise architect'],
  technical_writer: ['technical writer', 'documentation'],
  legal: ['general counsel', 'legal counsel', 'attorney', 'lawyer'],
  finance: ['finance manager', 'accountant', 'controller', 'financial analyst'],
  hr: ['human resources', 'hr manager', 'recruiter', 'talent acquisition'],
  marketing: ['marketing manager', 'growth manager', 'brand manager'],
  sales: ['sales manager', 'account executive', 'sales rep', 'bdr', 'sdr'],
  operations: ['operations manager', 'office manager'],
  // Healthcare
  nursing: ['nurse', 'nursing', 'rn', 'lpn', 'cna', 'nurse practitioner', 'registered nurse', 'charge nurse'],
  physician: ['physician', 'doctor', 'surgeon', 'medical doctor', 'attending physician'],
  allied_health: ['therapist', 'medical assistant', 'paramedic', 'pharmacy technician', 'pharmacist', 'dental hygienist', 'radiology technician'],
  mental_health: ['counselor', 'therapist', 'psychologist', 'social worker', 'mental health counselor'],
  // Education
  education: ['teacher', 'professor', 'instructor', 'tutor', 'principal', 'lecturer'],
  // Hospitality
  food_service: ['cook', 'chef', 'bartender', 'barista', 'waiter', 'kitchen'],
  hospitality: ['hotel', 'concierge', 'front desk', 'housekeeping', 'guest services'],
  // Retail / customer service
  retail: ['retail', 'cashier', 'sales associate', 'store manager', 'merchandiser'],
  customer_service: ['customer service', 'csr', 'call center', 'customer support representative'],
  // Trades
  skilled_trades: ['electrician', 'plumber', 'hvac', 'welder', 'carpenter', 'machinist'],
  mechanic: ['mechanic', 'auto technician', 'diesel mechanic', 'maintenance technician'],
  manufacturing: ['production worker', 'machine operator', 'manufacturing', 'cnc operator', 'assembly'],
  construction: ['construction', 'foreman', 'laborer', 'site superintendent', 'estimator'],
  // Transportation
  driver: ['truck driver', 'cdl driver', 'delivery driver', 'bus driver', 'courier'],
  warehouse: ['warehouse', 'fulfillment', 'picker', 'packer', 'shipping clerk'],
  logistics: ['logistics', 'dispatcher', 'supply chain'],
  // Creative
  creative_writer: ['writer', 'copywriter', 'editor', 'journalist', 'content writer'],
  video_creative: ['videographer', 'video editor', 'photographer', 'cinematographer'],
  artist: ['illustrator', 'art director', 'visual artist'],
  // Administrative
  administrative: ['administrative assistant', 'executive assistant', 'office manager', 'receptionist', 'secretary'],
  // Generic family keyword entries removed — see note in ROLE_FAMILIES above.
};

export function getRoleTitleKeywords(candidateTitles: string[]): string[] {
  if (candidateTitles.length === 0) return [];

  const families = new Set<string>();

  // Extract role families from all candidate titles
  for (const title of candidateTitles) {
    const family = extractRoleFamily(title);
    if (family) {
      families.add(family);
      // Also add related families for wider retrieval
      const related = RELATED_ROLE_FAMILIES[family];
      if (related) {
        for (const r of related) families.add(r);
      }
    }
  }

  // Convert families to searchable keywords
  const keywords = new Set<string>();
  for (const family of families) {
    const terms = ROLE_FAMILY_KEYWORDS[family];
    if (terms) {
      for (const term of terms) keywords.add(term);
    }
  }

  // Limit to prevent query explosion
  return Array.from(keywords).slice(0, 20);
}

const SENIORITY_LEVELS = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'vp', 'executive'];

function extractSeniority(title: string): string {
  const t = title.toLowerCase();
  if (/\b(intern|internship)\b/.test(t)) return 'intern';
  if (/\b(junior|jr\.?|entry)\b/.test(t)) return 'junior';
  if (/\b(senior|sr\.?)\b/.test(t)) return 'senior';
  if (/\bstaff\b/.test(t)) return 'staff';
  if (/\bprincipal\b/.test(t)) return 'principal';
  if (/\b(lead|team\s*lead)\b/.test(t)) return 'lead';
  if (/\bmanager\b/.test(t)) return 'manager';
  if (/\bdirector\b/.test(t)) return 'director';
  if (/\b(vp|vice\s*president)\b/.test(t)) return 'vp';
  if (/\b(chief|cto|ceo|coo|cfo)\b/.test(t)) return 'executive';
  return 'mid';
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Core scorer ────────────────────────────────────────────────────

/**
 * Score a single job against a candidate.
 *
 * @param candidateSkills  Pre-normalized skill strings
 * @param candidateExperienceLevel  e.g. 'entry' | 'mid' | 'senior' | null
 * @param job  Must have at least title; skills, description, vectorEmbedding optional
 * @param candidateEmbedding  Pre-parsed candidate vector (1024-dim), or undefined
 * @param candidateTitles  Previous job titles from resume (optional)
 * @param candidateContext  Location/work type for context bonus (optional)
 */
export function scoreJob(
  candidateSkills: string[],
  candidateExperienceLevel: string | null | undefined,
  job: JobLike,
  candidateEmbedding?: number[],
  candidateTitles?: string[],
  candidateContext?: CandidateContext,
  precomputedCosineDist?: number,
): JobScore {
  // ── 1. Keyword matching (35%) ──────────────────────────────────

  const jobSkills = (job.skills && (job.skills as string[]).length > 0)
    ? job.skills
    : extractSkillsFromText(job.description || '');

  const normalizedCand = candidateSkills.map(s => s.toLowerCase());
  const normalizedJob = parseSkillsInput(jobSkills).map(s => s.toLowerCase());
  const jobSkillsCount = Math.max(normalizedJob.length, 3);

  const exactMatches: string[] = [];
  const exactMatchSet = new Set<string>();
  for (let i = 0; i < normalizedCand.length; i++) {
    if (normalizedJob.includes(normalizedCand[i]) && !exactMatchSet.has(normalizedCand[i])) {
      exactMatchSet.add(normalizedCand[i]);
      exactMatches.push(candidateSkills[i]);
    }
  }

  const partialMatches: string[] = [];
  const partialMatchSet = new Set<string>();
  for (const skill of candidateSkills) {
    for (const related of getRelatedSkills(skill)) {
      const r = related.toLowerCase();
      if (normalizedJob.includes(r) && !exactMatchSet.has(r) && !partialMatchSet.has(r)) {
        partialMatchSet.add(r);
        partialMatches.push(related);
      }
    }
  }

  const effectiveMatches = exactMatches.length + 0.5 * partialMatches.length;
  const keywordScore = Math.min(100, Math.round((effectiveMatches / jobSkillsCount) * 100));
  const hasSkillOverlap = effectiveMatches > 0;

  // ── 2. Semantic similarity (25%) ───────────────────────────────

  let semanticScore = 0;
  let hasSemanticSignal = false;

  if (precomputedCosineDist !== undefined) {
    // Use pre-computed cosine distance from pgvector (avoids JSON.parse + re-computation)
    // cosine distance = 1 - similarity, so similarity = 1 - distance
    const similarity = 1 - precomputedCosineDist;
    semanticScore = Math.min(100, Math.max(0, Math.round(((similarity - 0.3) / 0.5) * 100)));
    hasSemanticSignal = true;
  } else if (candidateEmbedding && candidateEmbedding.length > 0 && job.vectorEmbedding) {
    try {
      const jobEmbedding: number[] = JSON.parse(job.vectorEmbedding);
      if (jobEmbedding.length === candidateEmbedding.length) {
        const similarity = cosineSimilarity(candidateEmbedding, jobEmbedding);
        semanticScore = Math.min(100, Math.max(0, Math.round(((similarity - 0.3) / 0.5) * 100)));
        hasSemanticSignal = true;
      }
    } catch { /* malformed embedding — skip */ }
  }

  // ── 3. Title/role relevance (25%) ──────────────────────────────

  const titleScore = scoreTitleRelevance(candidateTitles || [], job.title || '');

  // hasRoleMatch must reflect actual role-family alignment, not just titleScore
  // crossing 40. titleScore can hit 40 via jaccard + seniority alignment alone:
  // extractSeniority defaults to 'mid' for unmarked titles, so a 'mid' nurse
  // ↔ 'senior' SWE pair gets +12 seniority points (diff of 1), plus stray
  // jaccard from connector words ("senior", "front", etc.) can push titleScore
  // past 40 even when the role families clearly disagree. Require positive
  // role-family compatibility when both sides classify; default to permissive
  // when either side is unclassified (conservative, matches prior behavior).
  const _jobRoleFamily = extractRoleFamily(job.title || '');
  const _candRoleFamilies = (candidateTitles || [])
    .map(t => extractRoleFamily(t))
    .filter((r): r is string => r !== null);
  const _familyCompatible =
    !_jobRoleFamily ||
    _candRoleFamilies.length === 0 ||
    _candRoleFamilies.some(r => {
      if (r === _jobRoleFamily) return true;
      const related = RELATED_ROLE_FAMILIES[_jobRoleFamily] || [];
      return related.includes(r);
    });
  const hasRoleMatch = titleScore >= 40 && _familyCompatible;

  // ── 4. Experience level (15%) ──────────────────────────────────

  let experienceScore = 50; // neutral default
  if (candidateExperienceLevel && job.title) {
    const multiplier = experienceLevelMultiplier(candidateExperienceLevel, job.title);
    experienceScore = Math.round(multiplier * 100);
  }

  // Gate experience credit on actual role alignment. Two senior-titled jobs
  // in unrelated families (e.g. Senior UX Designer ↔ Senior Fund Accountant)
  // shouldn't get full experience-level credit just because they share
  // "senior" — the level alignment is meaningless without role overlap.
  if (!hasRoleMatch) {
    experienceScore = Math.min(experienceScore, 50);
  }

  // ── 5. Context bonus: location + work type (up to +8 points) ──
  // Additive bonus, not a percentage weight — rewards good fit without
  // inflating scores for irrelevant jobs. Max +8 so it can't flip a
  // bad match into a good one (30% threshold is still the gatekeeper).

  let contextBonus = 0;

  if (candidateContext) {
    const jobLoc = (job.location || '').toLowerCase();
    const candLoc = (candidateContext.location || '').toLowerCase();
    const jobWork = (job.workType || '').toLowerCase();
    const candWork = (candidateContext.workType || '').toLowerCase();

    // Location: +4 for match or remote job, +2 for same state/region
    if (jobLoc && candLoc) {
      const isRemoteJob = jobWork.includes('remote') || jobLoc.includes('remote');
      if (isRemoteJob) {
        contextBonus += 4; // remote = fits anyone
      } else if (candLoc === jobLoc || jobLoc.includes(candLoc) || candLoc.includes(jobLoc)) {
        contextBonus += 4; // same city/area
      } else {
        // Check same state (e.g. "Seattle, WA" and "Bellevue, WA" both contain "wa")
        const candState = candLoc.split(',').pop()?.trim();
        const jobState = jobLoc.split(',').pop()?.trim();
        if (candState && jobState && candState.length <= 3 && candState === jobState) {
          contextBonus += 2;
        }
      }
    }

    // Work type: +4 for exact match, +2 for hybrid↔remote/onsite
    if (jobWork && candWork) {
      if (candWork === jobWork) {
        contextBonus += 4;
      } else if (candWork === 'hybrid' || jobWork === 'hybrid') {
        contextBonus += 2; // hybrid is flexible
      }
    }
  }

  // ── Blend (uses learned weights when available) ──────────────

  const w = getWeights();
  let matchScore: number;

  if (hasSemanticSignal) {
    // Full blend with all 4 components
    matchScore = Math.round(
      w.keyword * keywordScore +
      w.semantic * semanticScore +
      w.title * titleScore +
      w.experience * experienceScore
    );
  } else {
    // No embeddings: redistribute semantic weight proportionally
    const noSemTotal = w.keyword + w.title + w.experience;
    matchScore = Math.round(
      (w.keyword / noSemTotal) * keywordScore +
      (w.title / noSemTotal) * titleScore +
      (w.experience / noSemTotal) * experienceScore
    );
  }

  // Apply context bonus (additive, capped at 100)
  matchScore = Math.min(100, matchScore + contextBonus);

  // ── Hard cap: no role-family match ────────────────────────────
  // Role-family mismatch is the dominant signal that a job is wrong-career
  // noise. A stray skill overlap (e.g. "Communication" or "Excel" matching
  // across a Market Manager and an IT Support candidate) should NOT lift
  // the score above the feed floor, which it does today: 1 generic skill
  // match contributes ~7 keyword points and combined with seniority +
  // semantic similarity cosmetics produces 30%+ scores for unrelated roles.
  // Cap below the 30% feed floor when role family doesn't match, regardless
  // of stray skill overlap. Skill-only matches still rank, just below the
  // floor where they belong. hasRoleMatch is true by default when the
  // candidate has no titles to compare (titleScore returns 50), so this
  // gate only fires when we have evidence of a different career family.
  if (!hasRoleMatch) {
    matchScore = Math.min(matchScore, hasSkillOverlap ? 29 : 25);
  }

  // ── Explanation ────────────────────────────────────────────────

  const explanationParts: string[] = [];

  if (titleScore >= 70) {
    explanationParts.push(`Strong role match for ${job.title}`);
  } else if (titleScore >= 40) {
    explanationParts.push(`Related role: ${job.title}`);
  }

  if (effectiveMatches > 0) {
    explanationParts.push(`${exactMatches.length} direct + ${partialMatches.length} related skill matches`);
  }

  if (hasSemanticSignal && semanticScore > 30) {
    explanationParts.push(`${semanticScore}% profile similarity`);
  }

  if (experienceScore >= 90) {
    explanationParts.push('Experience level aligns well');
  } else if (experienceScore < 60) {
    const jobLevel = inferJobLevel(job.title || '');
    const idx: Record<string, number> = { entry: 0, mid: 1, senior: 2, lead: 3, executive: 4 };
    const candIdx = idx[candidateExperienceLevel || 'mid'] ?? 1;
    explanationParts.push(candIdx > jobLevel ? 'Slightly above your level' : 'Stretch role');
  }

  if (contextBonus >= 6) {
    explanationParts.push('Good location & work type fit');
  } else if (contextBonus >= 4) {
    explanationParts.push('Location or work type matches');
  }

  if (explanationParts.length === 0) {
    explanationParts.push('Limited match: different role or skill set');
  }

  const explanation = explanationParts.join('. ');

  return {
    matchScore,
    matchTier: getMatchTier(matchScore),
    skillMatches: exactMatches,
    partialSkillMatches: partialMatches,
    aiExplanation: explanation,
    confidenceLevel: hasSemanticSignal ? 2 : 1,
    components: {
      keywordScore,
      semanticScore,
      titleScore,
      experienceScore,
      contextBonus,
      hasSemanticSignal,
    },
  };
}

// ── Title/role scoring ────────────────────────────────────────────

/**
 * Score how well candidate's previous titles match the job title.
 * Returns 0-100.
 *
 * Three signals:
 *   1. Word overlap (Jaccard) — 30%
 *   2. Role family match — 50%
 *   3. Seniority alignment — 20%
 */
function scoreTitleRelevance(candidateTitles: string[], jobTitle: string): number {
  if (!jobTitle) return 50;
  if (candidateTitles.length === 0) return 50; // no data — neutral

  const normalizedJobTitle = normalizeTitle(jobTitle);
  const jobTitleWords = new Set(normalizedJobTitle.split(/\s+/).filter(w => w.length > 2));
  const jobRole = extractRoleFamily(jobTitle);
  const jobSeniority = extractSeniority(jobTitle);

  let bestScore = 0;

  for (const candidateTitle of candidateTitles) {
    const normalizedCandTitle = normalizeTitle(candidateTitle);
    const candTitleWords = new Set(normalizedCandTitle.split(/\s+/).filter(w => w.length > 2));
    const candRole = extractRoleFamily(candidateTitle);
    const candSeniority = extractSeniority(candidateTitle);

    let score = 0;

    // Signal 1: Word overlap (Jaccard) — 30 points max
    const intersection = new Set([...jobTitleWords].filter(w => candTitleWords.has(w)));
    const union = new Set([...jobTitleWords, ...candTitleWords]);
    const jaccard = union.size > 0 ? intersection.size / union.size : 0;
    score += jaccard * 30;

    // Signal 2: Role family match — 50 points max
    if (jobRole && candRole) {
      if (jobRole === candRole) {
        score += 50; // Same role family
      } else {
        const related = RELATED_ROLE_FAMILIES[jobRole];
        if (related?.includes(candRole)) {
          score += 25; // Related role
        }
        // else: 0 — completely different role families
      }
    } else if (!jobRole && !candRole) {
      score += 5; // Both unclassified — minimal symmetric credit
    }
    // else: one side known, the other unknown — 0 credit. Previously gave +15
    // but that let junk candidate titles (parser-extracted sentence fragments,
    // city names) inflate scores against well-classified job titles in
    // unrelated families (e.g. Senior Fund Accountant ranking high for a
    // UX Designer because junk titles couldn't be classified).

    // Signal 3: Seniority alignment — 20 points max
    if (jobSeniority === candSeniority) {
      score += 20;
    } else {
      const diff = Math.abs(SENIORITY_LEVELS.indexOf(jobSeniority) - SENIORITY_LEVELS.indexOf(candSeniority));
      if (diff <= 1) score += 12;
      else if (diff <= 2) score += 6;
    }

    bestScore = Math.max(bestScore, score);
  }

  return Math.min(Math.round(bestScore), 100);
}

// ── Helpers ────────────────────────────────────────────────────────

export function getMatchTier(score: number): 'great' | 'good' | 'worth-a-look' {
  if (score >= 75) return 'great';
  if (score >= 50) return 'good';
  return 'worth-a-look';
}

export function getFreshnessLabel(createdAt: Date | null): { freshness: 'just-posted' | 'this-week' | 'recent'; daysOld: number } {
  if (!createdAt) return { freshness: 'recent', daysOld: 15 };
  const daysOld = Math.floor((Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24));
  if (daysOld <= 3) return { freshness: 'just-posted', daysOld };
  if (daysOld <= 7) return { freshness: 'this-week', daysOld };
  return { freshness: 'recent', daysOld };
}

export function computeRecencyScore(createdAt: Date | null | undefined): number {
  if (!createdAt) return 0.5;
  const daysOld = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (daysOld < 1) return 1.0;
  if (daysOld < 3) return 0.9;
  if (daysOld < 7) return 0.8;
  if (daysOld < 14) return 0.6;
  if (daysOld < 30) return 0.4;
  return 0.2;
}

export function inferJobLevel(title: string): number {
  const t = title.toLowerCase();
  if (/\b(junior|jr\.?|entry[\s-]level|associate|trainee|intern|graduate)\b/.test(t)) return 0;
  if (/\b(senior|sr\.?)\b/.test(t)) return 2;
  if (/\b(staff|lead|principal|manager)\b/.test(t)) return 3;
  if (/\b(director|vp|vice[\s-]president|head of|chief|cto|ceo)\b/.test(t)) return 4;
  return 1;
}

/**
 * Asymmetric experience multiplier:
 *   Over-qualified  → lighter penalty (you can do the work)
 *   Under-qualified → heavier penalty (it's a stretch)
 */
export function experienceLevelMultiplier(candidateLevel: string, jobTitle: string): number {
  const idx: Record<string, number> = { entry: 0, mid: 1, senior: 2, lead: 3, executive: 4 };
  const candidateIdx = idx[candidateLevel] ?? 1;
  const jobIdx = inferJobLevel(jobTitle);
  const diff = candidateIdx - jobIdx;

  if (diff === 0) return 1.00;

  if (diff > 0) {
    if (diff === 1) return 0.90;
    if (diff === 2) return 0.75;
    return 0.60;
  }

  if (diff === -1) return 0.80;
  if (diff === -2) return 0.60;
  return 0.40;
}
