import { SKILL_ALIASES } from '../skill-normalizer';
/**
 * Shared skill extraction utility.
 * Scans free-text descriptions for known skills using precompiled regexes.
 * Covers tech, healthcare, finance, sales, trades, logistics, and more.
 */

export const KNOWN_SKILL_TERMS: readonly string[] = [
  // ── Programming languages ──────────────────────────────────────────────
  'javascript', 'typescript', 'python', 'java', 'go', 'golang', 'rust', 'c++', 'c#', 'ruby', 'php', 'swift', 'kotlin', 'scala', 'r',
  // ── Frontend ───────────────────────────────────────────────────────────
  'react', 'vue', 'angular', 'svelte', 'next.js', 'nextjs', 'html', 'css', 'sass', 'less', 'tailwind', 'bootstrap',
  // ── Backend & frameworks ───────────────────────────────────────────────
  'node.js', 'nodejs', 'express', 'django', 'flask', 'fastapi', 'spring', 'rails', '.net', 'asp.net',
  // ── Databases ──────────────────────────────────────────────────────────
  'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'dynamodb', 'cassandra', 'oracle',
  // ── Cloud & DevOps ─────────────────────────────────────────────────────
  'aws', 'azure', 'gcp', 'google cloud', 'docker', 'kubernetes', 'k8s', 'terraform', 'ansible', 'jenkins', 'ci/cd', 'devops',
  // ── Data & ML ──────────────────────────────────────────────────────────
  'tensorflow', 'pytorch', 'keras', 'pandas', 'numpy', 'scikit-learn', 'spark', 'hadoop', 'tableau', 'power bi',
  'machine learning', 'deep learning', 'nlp', 'natural language processing', 'computer vision', 'llm', 'gpt',
  'openai', 'langchain', 'llamaindex', 'chatgpt', 'data analysis', 'data visualization', 'data modeling',
  // ── Dev tools & practices ──────────────────────────────────────────────
  'git', 'github', 'gitlab', 'jira', 'agile', 'scrum', 'rest api', 'graphql', 'microservices', 'linux', 'unix',
  'rest', 'grpc', 'websocket', 'oauth', 'jwt', 'json', 'xml', 'yaml',

  // ── Finance & Accounting ───────────────────────────────────────────────
  'accounting', 'bookkeeping', 'financial analysis', 'financial modeling', 'budgeting', 'forecasting',
  'accounts payable', 'accounts receivable', 'general ledger', 'gaap', 'ifrs',
  'quickbooks', 'sap', 'netsuite', 'tax preparation', 'auditing', 'payroll',
  'financial reporting', 'cost accounting', 'risk management', 'compliance',

  // ── Healthcare ─────────────────────────────────────────────────────────
  'patient care', 'electronic medical records', 'emr', 'ehr', 'epic', 'cerner',
  'hipaa', 'hipaa compliance', 'bls certified', 'cpr certified', 'acls',
  'phlebotomy', 'medical coding', 'medical billing', 'icd-10', 'clinical research',
  'nursing', 'pharmacology', 'vital signs', 'triage', 'wound care',
  'physical therapy', 'occupational therapy', 'radiology', 'sonography',

  // ── Sales & Marketing ──────────────────────────────────────────────────
  'salesforce', 'hubspot', 'crm', 'lead generation', 'cold calling', 'b2b sales', 'b2c sales',
  'account management', 'business development', 'pipeline management', 'negotiation',
  'seo', 'sem', 'google ads', 'facebook ads', 'social media marketing', 'content marketing',
  'email marketing', 'marketing automation', 'google analytics', 'a/b testing',
  'copywriting', 'brand management', 'market research', 'public relations',

  // ── Human Resources ────────────────────────────────────────────────────
  'recruiting', 'talent acquisition', 'onboarding', 'employee relations',
  'performance management', 'benefits administration', 'hris', 'workday',
  'adp', 'compensation analysis', 'labor law', 'diversity and inclusion',

  // ── Project Management & Operations ────────────────────────────────────
  'project management', 'program management', 'pmp', 'prince2', 'six sigma', 'lean',
  'supply chain management', 'logistics', 'inventory management', 'procurement',
  'warehouse management', 'vendor management', 'process improvement', 'kaizen',
  'microsoft project', 'asana', 'monday.com', 'trello', 'confluence',

  // ── Customer Service ───────────────────────────────────────────────────
  'customer service', 'customer support', 'call center', 'zendesk', 'intercom',
  'help desk', 'technical support', 'conflict resolution', 'de-escalation',
  'live chat', 'ticketing systems', 'customer retention', 'nps',

  // ── Trades & Construction ──────────────────────────────────────────────
  'osha', 'osha compliance', 'blueprint reading', 'electrical', 'plumbing', 'hvac',
  'welding', 'carpentry', 'concrete', 'heavy equipment', 'forklift',
  'safety compliance', 'building codes', 'autocad', 'construction management',

  // ── Legal ──────────────────────────────────────────────────────────────
  'contract review', 'legal research', 'litigation', 'paralegal',
  'regulatory compliance', 'corporate law', 'intellectual property', 'due diligence',

  // ── Education & Training ───────────────────────────────────────────────
  'curriculum development', 'instructional design', 'classroom management',
  'lesson planning', 'e-learning', 'lms', 'training development', 'tutoring',

  // ── Office & Admin ─────────────────────────────────────────────────────
  'microsoft office', 'excel', 'word', 'powerpoint', 'outlook', 'google workspace',
  'data entry', 'typing', 'scheduling', 'office management', 'filing',
  'pos systems', 'cash handling', 'erp',

  // ── Food Service ───────────────────────────────────────────────────────
  'food safety', 'servsafe', 'food preparation', 'menu planning', 'catering',
  'kitchen management', 'food handling',

  // ── Transportation ─────────────────────────────────────────────────────
  'cdl', 'dot compliance', 'route planning', 'fleet management', 'dispatching',
];

// Canonical display name for each skill (lowercase key → display value)
const CASING: Record<string, string> = {
  // Tech
  'aws': 'AWS', 'gcp': 'GCP', 'k8s': 'Kubernetes', 'ai': 'AI', 'ml': 'ML', 'nlp': 'NLP',
  'llm': 'LLM', 'gpt': 'GPT', 'jwt': 'JWT', 'json': 'JSON', 'xml': 'XML', 'yaml': 'YAML',
  'html': 'HTML', 'css': 'CSS', 'sql': 'SQL', 'grpc': 'gRPC', 'oauth': 'OAuth',
  'c++': 'C++', 'c#': 'C#', '.net': '.NET', 'asp.net': 'ASP.NET',
  'rest api': 'REST API', 'rest': 'REST', 'ci/cd': 'CI/CD', 'devops': 'DevOps',
  'nextjs': 'Next.js', 'next.js': 'Next.js', 'node.js': 'Node.js', 'nodejs': 'Node.js',
  'scikit-learn': 'scikit-learn', 'tensorflow': 'TensorFlow', 'pytorch': 'PyTorch',
  'llamaindex': 'LlamaIndex', 'langchain': 'LangChain', 'openai': 'OpenAI', 'chatgpt': 'ChatGPT',
  'github': 'GitHub', 'gitlab': 'GitLab', 'graphql': 'GraphQL', 'postgresql': 'PostgreSQL',
  'mongodb': 'MongoDB', 'elasticsearch': 'Elasticsearch', 'dynamodb': 'DynamoDB',
  'websocket': 'WebSocket', 'google cloud': 'Google Cloud', 'power bi': 'Power BI',
  'machine learning': 'Machine Learning', 'deep learning': 'Deep Learning',
  'natural language processing': 'Natural Language Processing', 'computer vision': 'Computer Vision',
  'microservices': 'Microservices',
  // Finance
  'gaap': 'GAAP', 'ifrs': 'IFRS', 'sap': 'SAP', 'erp': 'ERP', 'netsuite': 'NetSuite',
  // Healthcare
  'emr': 'EMR', 'ehr': 'EHR', 'epic': 'Epic', 'cerner': 'Cerner',
  'hipaa': 'HIPAA', 'hipaa compliance': 'HIPAA Compliance',
  'bls certified': 'BLS Certified', 'cpr certified': 'CPR Certified', 'acls': 'ACLS',
  'icd-10': 'ICD-10',
  // Sales & Marketing
  'salesforce': 'Salesforce', 'hubspot': 'HubSpot', 'crm': 'CRM',
  'seo': 'SEO', 'sem': 'SEM', 'b2b sales': 'B2B Sales', 'b2c sales': 'B2C Sales',
  'google ads': 'Google Ads', 'google analytics': 'Google Analytics',
  'a/b testing': 'A/B Testing', 'nps': 'NPS',
  // HR
  'hris': 'HRIS', 'adp': 'ADP',
  // PM
  'pmp': 'PMP', 'prince2': 'PRINCE2',
  // Trades
  'osha': 'OSHA', 'osha compliance': 'OSHA Compliance', 'hvac': 'HVAC',
  'autocad': 'AutoCAD', 'cdl': 'CDL', 'dot compliance': 'DOT Compliance',
  // Support
  'zendesk': 'Zendesk', 'intercom': 'Intercom',
  // Office
  'pos systems': 'POS Systems', 'lms': 'LMS',
  // Food
  'servsafe': 'ServSafe',
};

function canonicalize(skill: string): string {
  return CASING[skill.toLowerCase()] ??
    skill.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Reading skills from prose (job descriptions) ───────────────────────────
// One extractor for every path that reads a posting (ingestion, Fleet import, scrapers, the
// scorer's fallback). The vocabulary is the list above plus the resume alias table, but prose is
// not a skills list, so three kinds of term are held back (measured on 4,697 live postings,
// 2026-10-14, where 'Compensation Analysis' had been tagged on 42,738 jobs, 'Go' on 13,629,
// 'C' on 4,202, 'React Native' on every 'RN' nursing job):
//   1. Expansions: a short or partial word mapped to a different, longer skill ('rn' → React
//      Native, 'compensation' → Compensation Analysis, 'next' → Next.js). In prose the word means
//      something else. Kept when it has a digit or symbol ('k8s', 'c++').
//   2. Single letters ('c', 'r').
//   3. Product and language names that are also everyday words: counted only when written as a
//      name (capitalized), never as the lowercase word ('Lean Six Sigma' yes, 'a lean team' no).
// Everything else matches in any case ('triage', 'welding', 'telemetry').
const EVERYDAY_WORD_NAMES = new Set([
  'go', 'word', 'excel', 'outlook', 'access', 'teams', 'lean', 'spring', 'express', 'swift', 'rust',
  'shell', 'spark', 'oracle', 'chef', 'puppet', 'ruby', 'pearl', 'host', 'rest', 'less', 'next',
  'node', 'server', 'pos', 'pr', 'slack', 'notion', 'sage', 'square', 'box', 'zoom', 'flask',
  'gatsby', 'ember', 'meteor', 'mercury', 'jest', 'mocha', 'karma', 'jasmine', 'airflow', 'dart',
  'julia', 'crystal', 'elm', 'ionic', 'electron', 'unity', 'maven', 'gradle', 'ant', 'redux',
  'vault', 'consul', 'nomad', 'helm', 'storm', 'beam', 'hive', 'pig', 'flink', 'looker', 'mode',
  'segment', 'amplitude', 'mixpanel', 'heap', 'ads', 'analytics', 'workday', 'epic',
]);

// Short alias-table acronyms that mean something else in postings ('RN' is a nurse, not React
// Native; 'PR' is public relations or a pull request; 'POS' a point of sale).
const AMBIGUOUS_ACRONYMS = new Set(['rn', 'pr', 'pos', 'ar', 'ap', 'ot', 'pt', 'ma', 'pa', 'er', 'or', 'ma']);

let PROSE_TERMS: Array<{ term: string; canonical: string; re: RegExp; nameOnly: boolean; acronymOnly: boolean }> | null = null;
function proseTerms() {
  if (PROSE_TERMS) {return PROSE_TERMS;}
  const curated = new Set(KNOWN_SKILL_TERMS.map(t => t.toLowerCase()));
  const vocab = new Map<string, string>();  // lowercase term → canonical display name
  // Canonical names come from the alias table first, the same names resumes are normalized to,
  // so a job's 'TypeScript' and a candidate's 'TypeScript' compare equal.
  for (const t of curated) {vocab.set(t, SKILL_ALIASES[t] ?? canonicalize(t));}
  for (const [alias, canonical] of Object.entries(SKILL_ALIASES)) {
    const key = alias.toLowerCase();
    if (!vocab.has(key)) {vocab.set(key, canonical);}
  }
  const out: Array<{ term: string; canonical: string; re: RegExp; nameOnly: boolean; acronymOnly: boolean }> = [];
  for (const [term, canonical] of vocab) {
    const lettersOnly = /^[a-z]+$/.test(term);
    if (lettersOnly && term.length === 1) {continue;}                       // 2. single letters
    // 1. Expansions. The curated list above was written for prose, so its terms are not; an
    // alias-table word that maps to a different, longer skill is. A short one written in capitals
    // is an acronym and counts ('EHR'), unless the acronym means something else in postings.
    const expansion = lettersOnly && !curated.has(term) && term !== canonical.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (expansion && (term.length > 5 || AMBIGUOUS_ACRONYMS.has(term))) {continue;}
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out.push({
      term, canonical,
      // Word edges that also work for names ending in a symbol (c++, c#, .net).
      re: new RegExp(`(?<![A-Za-z0-9])${escaped}(?:s|es)?(?![A-Za-z0-9])`, 'gi'),
      nameOnly: EVERYDAY_WORD_NAMES.has(term),                              // 3. names that are words
      acronymOnly: expansion,
    });
  }
  PROSE_TERMS = out;
  return out;
}

/** Skills a posting's text asks for, read the way prose is written (see the rules above). */
export function extractSkillsFromText(text: string | undefined): string[] {
  if (!text) {return [];}
  const found = new Set<string>();
  for (const { canonical, re, nameOnly, acronymOnly } of proseTerms()) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      // A name written as the plain lowercase word is the word, not the name.
      if (nameOnly && m[0] === m[0].toLowerCase()) {continue;}
      // An alias-table acronym counts only written in capitals ('EHR', not 'ehr' inside prose).
      if (acronymOnly && m[0] !== m[0].toUpperCase()) {continue;}
      found.add(canonical);
      break;
    }
  }
  return Array.from(found);
}

// ── The candidate's own skills in a posting ────────────────────────────────
// The vocabulary above can never list every occupation's skills (2026-10-14: 76% of teaching and
// 67% of customer-service postings had none tagged; a nurse's 'Telemetry' or 'IV Therapy' matched
// nothing). So matching also asks the other way round: which of THIS person's skills does the
// posting mention? Any occupation, no list. Soft skills are left out: they appear in nearly every
// posting and say nothing about fit.
const SOFT_SKILLS = new Set([
  'communication', 'communication skills', 'leadership', 'teamwork', 'team work', 'collaboration',
  'problem solving', 'problem-solving', 'critical thinking', 'time management', 'adaptability',
  'creativity', 'attention to detail', 'organization', 'organizational skills', 'interpersonal skills',
  'work ethic', 'multitasking', 'self-motivated', 'flexibility', 'decision making', 'presentation skills',
  'analytical skills', 'detail oriented', 'detail-oriented', 'team player', 'positive attitude',
  'written communication', 'verbal communication', 'customer focus', 'reliability', 'professionalism',
]);

const mentionCache = new Map<string, Array<{ skill: string; re: RegExp; nameOnly: boolean; capsOnly: boolean }>>();

/** Which of these (candidate) skills the text mentions, read with the prose rules above. */
export function skillsMentioned(text: string | null | undefined, skills: string[]): string[] {
  if (!text || skills.length === 0) {return [];}
  const key = skills.join('\u0001');
  let terms = mentionCache.get(key);
  if (!terms) {
    terms = [];
    for (const skill of skills) {
      const s = String(skill ?? '').trim();
      const lower = s.toLowerCase();
      if (s.length < 2 || SOFT_SKILLS.has(lower)) {continue;}
      const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      terms.push({
        skill: s,
        re: new RegExp(`(?<![A-Za-z0-9])${escaped}(?:s|es)?(?![A-Za-z0-9])`, 'gi'),
        nameOnly: EVERYDAY_WORD_NAMES.has(lower),
        // Written as an acronym ('EHR', 'SQL', 'CNA'): count it only in capitals, not as a word.
        capsOnly: /^[A-Z]{2,4}$/.test(s),
      });
    }
    if (mentionCache.size > 500) {mentionCache.clear();}
    mentionCache.set(key, terms);
  }
  const found: string[] = [];
  for (const { skill, re, nameOnly, capsOnly } of terms) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (nameOnly && m[0] === m[0].toLowerCase()) {continue;}
      if (capsOnly && m[0] !== m[0].toUpperCase()) {continue;}
      found.push(skill);
      break;
    }
  }
  return found;
}

/** Lowercase canonical names the prose extractor can produce (for re-reading stored skills). */
export function extractorVocabulary(): Set<string> {
  const names = new Set<string>();
  for (const t of KNOWN_SKILL_TERMS) {names.add((SKILL_ALIASES[t.toLowerCase()] ?? canonicalize(t)).toLowerCase());}
  for (const canonical of Object.values(SKILL_ALIASES)) {names.add(canonical.toLowerCase());}
  return names;
}
