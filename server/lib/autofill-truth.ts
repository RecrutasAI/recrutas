/**
 * Truthful autofill: facts are never guessed.
 *
 * A fact about the candidate is answered only from something they own: their saved answer
 * (Settings → Application answers), their resume (with the line or roles shown), or their profile
 * (location). Anything else comes back as "needs you". Every value carries where it came from,
 * so the extension can show it and the candidate can check it before submitting. Enforced here,
 * after the AI, so a model that ignores the prompt still can't put a guess on a form.
 *
 * Questions are sorted by what they ask, not how they're worded (measured on 1,623 real
 * Greenhouse questions from 183 live jobs, 2026-10-12: 761 distinct wordings, so answers are
 * kept per fact, never per question):
 *   - saved facts: asked once, reused on every form however it's worded (sponsorship, salary…);
 *   - computed facts: worked out from the candidate's own data (years with a skill from dated
 *     roles, "do you live in X" from the profile location, time zone, highest degree);
 *   - per-job facts: true for this job only (lifting, shifts, referrals, relatives, convictions):
 *     always the candidate's, never saved, never guessed;
 *   - essays: the AI's text, labeled a draft to review;
 *   - choices with an honest default ("how did you hear": Recrutas or a job board, EEO decline).
 */
import { resolveLocation, type PlaceIndex } from '../../shared/places';
import { type ResumeFacts, highestEducation, workHistoryValue, yearsWith } from './resume-facts';

export type FillSource = 'profile' | 'resume' | 'answer' | 'default' | 'draft';
export type Fact =
  | 'sponsorship' | 'work_auth' | 'citizenship' | 'over18' | 'clearance'
  | 'relocation' | 'start_date' | 'salary' | 'years_experience' | 'prior_employment' | 'work_arrangement'
  | 'drivers_license' | 'languages' | 'background_check'
  | 'residence' | 'time_zone' | 'commute' | 'education_level'
  | 'criminal_history' | 'physical' | 'schedule' | 'referral' | 'prior_application' | 'relatives' | 'restrictions' | 'employment_record'
  | 'work_history'
  | 'other';  // a required question nothing could answer

export interface FillField { id: string; label?: string; name?: string; type?: string; options?: string[]; required?: boolean }
/** `strict`: the extension may only pick an option that is the value or starts with it. */
export interface FillAction { fieldId: string; action: string; value?: string; reason?: string; source?: FillSource; evidence?: string; strict?: boolean }
/**
 * A question for the candidate. `saveAs`: the saved answer it fills (offer "use on every form");
 * `saveKey`: its wording, for a question that isn't a fact but may come back word for word.
 */
export interface NeedsYou { fieldId: string; label: string; fact: Fact | 'essay'; saveAs?: keyof Stated; saveKey?: string }

/**
 * Order matters: the first match wins. Per-job facts come before the broad ones ("If you were
 * referred, who?" is a referral, not a name field), sponsorship before authorization.
 */
const FACTS: Array<[Fact, RegExp]> = [
  ['criminal_history', /convicted|conviction|felony|misdemeanou?r|criminal (record|history|offen[cs]e|charge)|pled guilty|plead(ed)? guilty|driving (violations?|record|tickets?)|moving violations?|\bdui\b|\bdwi\b/i],
  ['restrictions', /non-?compete|non-?solicit|restrictive covenant|employment (contract|agreement)|under (a|an|any) (contract|agreement)|bound by (a|an|any)/i],
  ['employment_record', /discharged|terminated|fired|asked to resign|dismissed from/i],
  // A field of the employment-history section, filled from the resume's roles in order.
  ['work_history', /^(?!.*(reason|responsibilit|duties|why|describe|supervisor|manager|salary|pay|phone|contact|may we)).*(\b(current|most recent|recent|second|2nd|third|3rd)\b[^?]{0,40}\b(employer|company|job title|title|position)\b|\b(job title|title|position) (at|with) (your )?(current|most recent|second|2nd|third|3rd|previous)|\b(start|end) date (with|of|at|for) (your )?(current|most recent|second|2nd|third|3rd|previous)|^\s*your (current )?(job )?title:?\s*$|^\s*(current|most recent) (employer|company|job title|title)\b)/i],
  ['relatives', /\brelatives?\b|related to (a|an|any)|family member|(parent|guardian|spouse|sibling|child) of (a|an) (current|former)/i],
  ['prior_application', /(previously|ever|before) (applied|interviewed)|(applied|interviewed) (to|with|at|for|by) .{0,40}(before|previously|in the past)|have you (ever )?(applied|interviewed)\b/i],
  ['referral', /\breferr(al|ed|er)\b|refer(red)? you|referee/i],
  ['sponsorship', /sponsor|\bvisa\b|\bh-?1b\b/i],
  ['work_auth', /(legally |lawfully )?(authori[sz]ed|eligible|permitted|right|allowed) (to work|for employment)|work authori[sz]ation|without restriction|work permit|permission to work/i],
  ['citizenship', /\bu\.?s\.? citizen|citizen of the united states|citizenship/i],
  ['over18', /(at least|over|older than) (18|eighteen)|18 years of age|age of 18/i],
  ['clearance', /security clearance|\bclearance\b|\bts\/sci\b|top secret/i],
  ['relocation', /relocat/i],
  ['drivers_license', /driver'?s'? licen[cs]e|driving licen[cs]e|valid licen[cs]e to drive/i],
  ['background_check', /background (check|screen|investigation)|drug (test|screen)/i],
  ['physical', /\blift(ing)?\b|\bpounds\b|\blbs?\b|stand(ing)? for|physical(ly)? (able|demands|requirements)|perform the essential functions/i],
  ['schedule', /\bshifts?\b|weekends?|overtime|on-?call|night(s| shift)?\b|\btravel\b|offsites?|holidays|days (are you|you are) available|availability to work|full[- ]time|part[- ]time|\bprn\b|hours (per|a) week/i],
  ['time_zone', /time ?zone/i],
  ['commute', /commut/i],
  ['residence', /\b(reside|live|living)\b.{0,40}\b(in|near|within|around)\b|currently (located|based|residing)|(located|based) in|surrounding area|where (are you|do you) (currently )?(live|located|based|reside)|what (city|state) do you live/i],
  ['work_arrangement', /\bhybrid\b|\bon-?site\b|\bin[- ]office\b|\bin (the|our) office\b|days (a|per) week/i],
  ['start_date', /notice period|earliest (start|available)|when can you start|start date|available to start|earliest availability/i],
  ['salary', /salary|compensation|expected pay|desired pay|pay expectation|hourly rate|rate expectation/i],
  ['years_experience', /\byears? of (\w+ )*experience|\d+\+? (or more )?years|how many years/i],
  ['prior_employment', /\b(worked|been employed|employed)\b.{0,60}\b(before|previously|in the past)\b|\bpreviously (worked|been employed)\b|\b(former(ly)?|past|current|existing) (an? )?employee\b|ever been employed by|currently (work|employed) (for|at|by)/i],
  ['languages', /\blanguages?\b|\bfluent\b|fluency|bilingual|\bspeak\b|proficiency in (spanish|english|french|german|mandarin|portuguese)/i],
  ['education_level', /highest (level of )?(education|degree)|level of education|high school diploma|\bged\b|education level|degree (have you|did you) (complete|earn)/i],
];

/** A question's wording as the shared map keys it: lowercased, punctuation removed. */
export const labelKey = (label: string): string => (label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 300);

/**
 * The fact a question asks: the fixed rules first, then the shared map of wordings the rules
 * missed (server/services/question-topics.service.ts), where 'none' means "not a fact".
 */
export function factOf(field: FillField, topics?: ReadonlyMap<string, Fact | 'none'>): Fact | null {
  const text = `${field.label || ''} ${field.name || ''}`.replace(/[\u2018\u2019`]/g, "'").replace(/\s+/g, ' ');
  for (const [fact, re] of FACTS) {if (re.test(text)) {return fact;}}
  const mapped = topics?.get(labelKey(field.label || ''));
  if (!mapped || mapped === 'none') {return null;}
  // A mapped yes/no fact counts only on a yes/no field: "Current/Most recent Employer:" (a name
  // box) is not "have you worked here before", whatever the classifier said.
  if (YES_NO_SHAPED.has(mapped) && !(field.options?.some(o => isYes(o)) && field.options?.some(o => isNo(o)))) {return null;}
  return mapped;
}
/** Facts answered Yes/No: a wording mapped to one must sit on a Yes/No field. */
const YES_NO_SHAPED = new Set<Fact>(['sponsorship', 'work_auth', 'citizenship', 'over18', 'relocation', 'drivers_license', 'background_check',
  'prior_employment', 'criminal_history', 'referral', 'prior_application', 'relatives', 'restrictions', 'employment_record', 'commute', 'physical']);

/** What each fact means, for classifying a wording the rules missed. */
export const FACT_MEANINGS: Record<Exclude<Fact, 'other'>, string> = {
  sponsorship: 'needs visa/immigration sponsorship', work_auth: 'legally authorized / eligible to work in the US, or can prove it',
  citizenship: 'is a US citizen', over18: 'is at least 18', clearance: 'holds a security clearance', relocation: 'willing to relocate',
  start_date: 'when they can start / notice period', salary: 'pay expectations', years_experience: 'years of experience (overall or with something)',
  prior_employment: 'has worked for this employer (or its affiliates) before, or works there now', work_arrangement: 'able to work onsite / hybrid / in office',
  drivers_license: "holds a driver's license", languages: 'which languages they speak / language level', background_check: 'willing to take a background check or drug test',
  residence: 'where they live / whether they live in a given place or country', time_zone: 'their time zone', commute: 'can commute to the office',
  education_level: 'highest education / whether they hold a degree or diploma', criminal_history: 'convictions, criminal or driving record',
  physical: 'physical ability (lifting, standing)', schedule: 'shifts, hours, weekends, travel, days available, full/part time',
  referral: 'was referred / who referred them', prior_application: 'applied or interviewed here before', relatives: 'relatives or relationships at the employer',
  restrictions: 'non-compete, non-solicit or employment contract', employment_record: 'was fired, discharged or asked to resign',
  work_history: 'a field of their employment history: current / most recent / second employer, title, or the dates there',
};

/**
 * A question worth asking the shared map about: not one the rules already place (a fact, a
 * profile field, a default choice, an opt-in, an essay, a follow-up, the job itself).
 */
export function needsTopic(field: FillField): boolean {
  const label = field.label || '';
  if (field.type === 'file' || field.type === 'hidden' || labelKey(label).length < 8) {return false;}
  if (factOf(field)) {return false;}
  return !isProfileField(field) && ![DEFAULT_FIELD, HOW_HEARD, OPT_IN, ABOUT_THE_JOB, FOLLOW_UP].some(re => re.test(label)) && !isEssay(field);
}

/** The candidate's saved answers (Settings → Application answers), keyed as stored. */
export type Stated = Partial<Record<'workAuthorizedUS' | 'needsSponsorship' | 'usCitizen' | 'over18' | 'securityClearance' | 'willingToRelocate'
  | 'noticePeriod' | 'desiredSalary' | 'driversLicense' | 'languages' | 'backgroundCheck', string>>;

/** Facts answered from a saved answer; the extension offers to save what the candidate types. */
export const STATED_KEY: Partial<Record<Fact, keyof Stated>> = {
  sponsorship: 'needsSponsorship', work_auth: 'workAuthorizedUS', citizenship: 'usCitizen', over18: 'over18',
  clearance: 'securityClearance', relocation: 'willingToRelocate', start_date: 'noticePeriod', salary: 'desiredSalary',
  drivers_license: 'driversLicense', languages: 'languages', background_check: 'backgroundCheck',
};
const CLEARANCE_LABEL: Record<string, string> = { none: 'None', public_trust: 'Public Trust', secret: 'Secret', top_secret: 'Top Secret', ts_sci: 'TS/SCI' };
const YES_NO_FACTS = new Set<Fact>(['sponsorship', 'work_auth', 'citizenship', 'over18', 'relocation', 'drivers_license', 'background_check']);
/** True for this job only: never saved, never filled by anyone but the candidate. */
const PER_JOB = new Set<Fact>(['criminal_history', 'physical', 'schedule', 'referral', 'prior_application', 'relatives', 'restrictions', 'employment_record']);
/** Marketing, SMS and talent-pool opt-ins: never signed up on the candidate's behalf. */
const OPT_IN = /\bsms\b|text messag|receive (updates|communications|messages|texts|marketing|job alerts)|job alerts|future (job )?opportunities|talent (pool|community|network)|retain my (profile|information)|marketing (emails|communications)|newsletter|opt[- ]?in/i;
/** The job itself ("what position are you applying for"): from the posting, not the candidate. */
const ABOUT_THE_JOB = /position (you are |you're )?applying (for|to)|role (you are |you're )?applying for|job (title )?(you are |you're )?applying for|requisition|job (id|number|code)/i;

const PROFILE_FIELD = /first[\s_-]?name|last[\s_-]?name|full[\s_-]?name|^name\b|e-?mail|phone|mobile|linkedin|github|portfolio|website|\bcity\b|location|country|\bstate\b|address|zip|postal|latitude|longitude/i;
const DEFAULT_FIELD = /gender|race|ethnic|hispanic|latino|veteran|disability|pronoun|confirm|acknowledge|certify|consent|i agree|privacy|terms/i;
/** "If yes, please explain…": it depends on the candidate's answer to the question before it. */
const FOLLOW_UP = /^\s*(\(?if (yes|no|so|applicable|not|you (answered|selected|checked|were|have|are|do|did))\b|please (explain|specify|describe|provide)[^?]{0,40}\bif (yes|so|applicable)\b)/i;
const HOW_HEARD = /how did you (hear|find|learn)|how'?d you (hear|find)|where did you (hear|find|see|learn)|how did this (job|role|position) come|^(application )?source$/i;
const ESSAY = /^\s*why\b|\bwhy (are|do|did|would) you\b|\bdescribe\b|\btell us\b|\bshare (a|an|with|your|how|what|about)\b|\bwalk us through\b|\bwhat (excites|interests|draws|attracts|motivates|makes)\b|\banything else\b|\badditional information\b|\bcover letter\b|\bexplain\b|\bhow (do|would) you approach\b|\bgive an example\b|\bexample of\b/i;

/** A contact or location field: a short label naming it ("Email", "LinkedIn profile link"), not a question that mentions it. */
const isProfileField = (field: FillField) => {
  const label = (field.label || field.name || '').trim();
  return label.length <= 45 && PROFILE_FIELD.test(label) && !/\?/.test(label);
};

function sourceOf(field: FillField, action: FillAction): FillSource {
  if (action.action === 'upload_resume') {return 'resume';}
  const text = `${field.label || ''} ${field.name || ''}`;
  if (DEFAULT_FIELD.test(text)) {return 'default';}
  if (isProfileField(field)) {return 'profile';}
  return 'resume';
}

/** Open-ended questions whose answer is written text, not a fact: the AI's text is a draft. */
function isEssay(field: FillField): boolean {
  if (field.options?.length) {return false;}
  const label = field.label || '';
  if (/^\s*(resume|cv|cover letter)\b/i.test(label)) {return false;}   // a paste-your-resume box, not a question
  return ESSAY.test(label) || (field.type === 'textarea' && !isProfileField(field));
}

// A lone y/n counts only as the whole answer: "N/A - Local to Denver" is not a "no".
const isYes = (v = '') => /^\s*(yes|true|i am|i do|i will|i have)\b|^\s*y\s*$/i.test(v);
const isNo = (v = '') => /^\s*(no|false|i am not|i do not|i don'?t|i will not|i won'?t)\b|^\s*n\s*$/i.test(v);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The yes or no option of a field (or plain Yes/No), and the action that sets it. */
function yesNoAction(field: FillField, yes: boolean): Pick<FillAction, 'action' | 'value'> {
  const opts = field.options || [];
  const value = (yes ? opts.find(o => isYes(o)) : opts.find(o => isNo(o))) || (yes ? 'Yes' : 'No');
  return { action: field.type === 'select' || field.type === 'radio' ? 'select' : 'click_then_type', value };
}
const looksYesNo = (field: FillField) => !!field.options?.length && field.options.some(o => isYes(o)) && field.options.some(o => isNo(o));

/** Everything the candidate owns that an answer may come from. */
export interface TruthContext {
  stated: Stated;
  resume: ResumeFacts;
  /** The candidate's profile location ("Seattle, WA"). */
  location?: string | null;
  jobCompany?: string | null;
  /** Answers the candidate saved from forms for other questions, by wording (labelKey). */
  custom?: Record<string, string>;
  /** Wordings the rules miss, as the shared map placed them (labelKey → fact or 'none'). */
  topics?: ReadonlyMap<string, Fact | 'none'>;
  /** The candidate's skills (profile), part of what a resume quote may come from. */
  skills?: string[];
  /** The US place list, for "do you live in X" and time zone; without it those need the candidate. */
  places?: PlaceIndex | null;
}

/**
 * The employers a "have you worked for X before?" question names ("…of Method, VCCP Group or any
 * of its agencies" names two), else the job's company.
 */
function employersAsked(label: string, jobCompany?: string | null): string[] {
  const named = label.match(/\b(?:for|at|by|of|with)\s+([A-Z][\w&.',/ -]{1,80}?)(?:\s+(?:before|previously|in the past)\b|\s+or any\b|\s*[?(]|$)/);
  if (named && !/^(us|this|our)\b/i.test(named[1])) {
    const list = named[1].split(/\s*(?:,|\bor\b|\band\b|\/)\s*/).map(n => n.trim()).filter(n => /^[A-Z]/.test(n) && n.length >= 2);
    if (list.length) {return list;}
  }
  return jobCompany?.trim() ? [jobCompany.trim()] : [];
}

/**
 * The subject of a years question ("Kubernetes" in "How many years of Kubernetes experience do
 * you have?"), or null when it asks about experience in general ("years of professional
 * experience"), which the resume's dated roles answer as a whole.
 */
const GENERIC_SUBJECT = /^(professional|relevant|related|work|working|total|overall|industry|full[- ]time|paid|post[- ]graduate|prior|previous|similar|direct|hands[- ]on|practical|real[- ]world|this|the|of|your|any)( (professional|relevant|related|work|working|full[- ]time|paid|industry|hands[- ]on|direct))*$/i;
/** "How many years for each skill below" or a grid row: one answer per item, the candidate's. */
export const PER_ITEM_YEARS = /(skills?|tools?|areas?|items?|technologies|platforms) (below|listed|above)|each of the following|the following (skills|areas|tools)|for each\b/i;

export function yearsSubject(label: string): string | null {
  const l = label.replace(/\s+/g, ' ');
  const qualified = l.match(/experience (?:do you have )?(?:exclusively|specifically|directly|solely|only) ([^?,.;()]{2,60})/i);
  if (qualified) {return qualified[1].replace(/\b(do you have|in total)\b.*$/i, '').trim();}
  const m = l.match(/years? of (?:professional |relevant |hands[- ]on |direct )?(?:experience )?(?:with|in|using|working with|as an?|as) ([^?,.;()]{2,50})/i)
    || l.match(/years? of ([^?,.;()]{2,40}?) experience/i)
    || l.match(/experience (?:do you have )?(?:with|in|using|as an?|as) ([^?,.;()]{2,50})/i);
  if (!m) {return null;}
  const subject = m[1].replace(/\b(do you have|have you|you have|experience|in total|total)\b.*$/i, '').trim();
  return subject && !GENERIC_SUBJECT.test(subject) ? subject : null;
}

/** "N or more years" in the question: a threshold to answer yes/no against. */
const yearsThreshold = (label: string): number | null => {
  const m = label.match(/(\d+)\s*\+?\s*(?:or more |plus )?years?/i) || label.match(/(?:at least|minimum of|more than) (\d+) years?/i);
  return m ? Number(m[1]) : null;
};

/** A years question answered from dated roles, as a number, a yes/no against a threshold, or an option. */
function yearsAnswer(field: FillField, ctx: TruthContext): Pick<FillAction, 'action' | 'value' | 'evidence'> | null {
  if (PER_ITEM_YEARS.test(field.label || '')) {return null;}
  const subject = yearsSubject(field.label || '');
  let years: number | null;
  let evidence: string;
  if (subject) {
    const w = yearsWith(ctx.resume, subject);
    if (!w) {return null;}
    years = w.years;
    evidence = w.evidence;
  } else {
    years = ctx.resume.totalYears;
    if (years == null || years <= 0) {return null;}
    evidence = `About ${years} year${years === 1 ? '' : 's'} of experience across the dated roles on your resume`;
  }
  const threshold = yearsThreshold(field.label || '');
  if (looksYesNo(field) && threshold != null) {return { ...yesNoAction(field, years >= threshold), evidence };}
  if (field.options?.length) {
    // Ranges as options ("0-2", "3-5", "5+"): the one the years fall in.
    const pick = field.options.find(o => {
      const r = o.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
      if (r) {return years! >= Number(r[1]) && years! <= Number(r[2]);}
      const plus = o.match(/(\d+)\s*\+|(\d+) or more|more than (\d+)/i);
      if (plus) {return years! >= Number(plus[1] ?? plus[2] ?? plus[3]);}
      const less = o.match(/less than (\d+)|under (\d+)|<\s*(\d+)/i);
      if (less) {return years! < Number(less[1] ?? less[2] ?? less[3]);}
      return Number(o.trim()) === years;
    });
    return pick ? { action: field.type === 'select' ? 'select' : 'click_then_type', value: pick, evidence } : null;
  }
  return { action: 'type', value: String(years), evidence };
}

function priorEmployment(field: FillField, ctx: TruthContext): Pick<FillAction, 'action' | 'value' | 'evidence'> | null {
  const employers = employersAsked(field.label || '', ctx.jobCompany);
  const known = ctx.resume.companies.filter(c => norm(c).length >= 3);
  if (!employers.length || !known.length) {return null;}
  const same = (a: string, b: string) => norm(a) === norm(b) || norm(a).includes(norm(b)) || norm(b).includes(norm(a));
  const hit = known.find(c => employers.some(e => same(c, e)));
  const names = employers.length > 1 ? `${employers.slice(0, -1).join(', ')} or ${employers[employers.length - 1]}` : employers[0];
  return {
    ...yesNoAction(field, !!hit),
    evidence: hit ? `${hit} is on your resume` : `${names} ${employers.length > 1 ? "aren't" : "isn't"} among the employers on your resume`,
  };
}

/**
 * "Do you live in Las Vegas?" from the profile location: yes when the question's place is the
 * candidate's, no when it's in another state; a different city in the same state could be a
 * suburb, so that one is the candidate's to answer. A free-text "where do you live" gets the
 * profile location itself.
 */
function residenceAnswer(field: FillField, ctx: TruthContext): Pick<FillAction, 'action' | 'value' | 'evidence'> | null {
  const loc = ctx.location?.trim();
  if (!loc) {return null;}
  const evidence = `Your profile location is ${loc}`;
  if (!field.options?.length) {return { action: 'type', value: loc, evidence };}
  if (!ctx.places) {return null;}
  const me = resolveLocation(loc, ctx.places);
  const inUS = me.states.length > 0;
  // "Country you live in" with a list: the United States option for a US location.
  if (!looksYesNo(field)) {
    const us = inUS ? field.options.find(o => /^(the )?(united states( of america)?|usa|u\.s\.a?\.?|us)$/i.test(o.trim())) : undefined;
    return us ? { action: field.type === 'select' ? 'select' : 'click_then_type', value: us, evidence } : null;
  }
  // "Do you live in one of the 48 contiguous United States or in Alaska?": the whole country.
  const label0 = field.label || '';
  if (/\b(united states|u\.s\.a?\.?|usa)\b/i.test(label0) && inUS && !resolveLocation(label0.replace(/\b(united states|u\.s\.a?\.?|usa)\b/gi, ' '), ctx.places).places.length) {
    const outside = /contiguous|lower 48|continental/i.test(label0) && me.states.some(st => st === 'AK' || st === 'HI') && !new RegExp(me.states.map(st => (st === 'AK' ? 'alaska' : 'hawaii')).join('|'), 'i').test(label0);
    return { ...yesNoAction(field, !outside), evidence };
  }
  // The place phrase, not the whole question: the resolver counts a place only when it makes up
  // its part ("Are you currently located in Seattle" is not one).
  const label = field.label || '';
  const phrase = label.match(/\b(?:in|near|within|around)\s+(?:the\s+)?(?:greater\s+)?(.+?)(?:\s+(?:or|and)\s+(?:the\s+)?(?:surrounding|greater|nearby|within)\b|\s+(?:metro(?:politan)?\s+)?area\b|\?|$)/i)?.[1];
  const asked = resolveLocation(phrase || label, ctx.places);
  if (!me.states.length || (!asked.places.length && !asked.states.length)) {return null;}
  if (asked.places.some(p => me.places.includes(p))) {return { ...yesNoAction(field, true), evidence };}
  if (!asked.places.length && asked.states.some(s => me.states.includes(s))) {return { ...yesNoAction(field, true), evidence };}
  if (asked.states.length && !asked.states.some(s => me.states.includes(s))) {return { ...yesNoAction(field, false), evidence };}
  return null;
}

/** States in one time zone only; split states need the candidate. */
const STATE_TZ: Record<string, 'Eastern' | 'Central' | 'Mountain' | 'Pacific' | 'Alaska' | 'Hawaii'> = {
  CT: 'Eastern', DE: 'Eastern', DC: 'Eastern', GA: 'Eastern', ME: 'Eastern', MD: 'Eastern', MA: 'Eastern', NH: 'Eastern', NJ: 'Eastern',
  NY: 'Eastern', NC: 'Eastern', OH: 'Eastern', PA: 'Eastern', RI: 'Eastern', SC: 'Eastern', VT: 'Eastern', VA: 'Eastern', WV: 'Eastern',
  AL: 'Central', AR: 'Central', IL: 'Central', IA: 'Central', LA: 'Central', MN: 'Central', MS: 'Central', MO: 'Central', OK: 'Central', WI: 'Central',
  AZ: 'Mountain', CO: 'Mountain', MT: 'Mountain', NM: 'Mountain', UT: 'Mountain', WY: 'Mountain',
  CA: 'Pacific', NV: 'Pacific', WA: 'Pacific', AK: 'Alaska', HI: 'Hawaii',
};
const TZ_WORDS: Record<string, RegExp> = {
  Eastern: /eastern|\bE[SD]?T\b/i, Central: /central|\bC[SD]?T\b/i, Mountain: /mountain|\bM[SD]?T\b/i,
  Pacific: /pacific|\bP[SD]?T\b/i, Alaska: /alaska|\bAK[SD]?T\b/i, Hawaii: /hawaii|\bHST\b/i,
};
function timeZoneAnswer(field: FillField, ctx: TruthContext): Pick<FillAction, 'action' | 'value' | 'evidence'> | null {
  if (!ctx.location || !ctx.places) {return null;}
  const states = resolveLocation(ctx.location, ctx.places).states;
  const zones = [...new Set(states.map(s => STATE_TZ[s]).filter(Boolean))];
  if (zones.length !== 1) {return null;}
  const zone = zones[0];
  const evidence = `Your profile location (${ctx.location}) is in ${zone} Time`;
  if (field.options?.length) {
    const pick = field.options.find(o => TZ_WORDS[zone].test(o));
    return pick ? { action: field.type === 'select' ? 'select' : 'click_then_type', value: pick, evidence } : null;
  }
  return { action: 'type', value: `${zone} Time`, evidence };
}

/**
 * "How did you hear about us?": the truth is that the candidate found the job on Recrutas, a job
 * board. Recrutas if the form offers it, else the form's job-board / online choice, else "Other".
 */
function howHeardAnswer(field: FillField): Pick<FillAction, 'action' | 'value' | 'evidence' | 'strict'> {
  const evidence = 'You found this job on Recrutas, a job board';
  const opts = field.options || [];
  // A dropdown whose options the page didn't list: the usual wording, so only a real match is picked.
  if (!opts.length) {return field.type === 'custom_select' || field.type === 'select' ? { action: 'click_then_type', value: 'Job board', evidence, strict: true } : { action: 'type', value: 'Recrutas (job board)', evidence };}
  // A general job board, never a narrower one that isn't true ("College Job Boards").
  const narrow = /college|universit|campus|school|career fair|military|veteran|diversity|government|niche|industry/i;
  const pick = opts.find(o => /recrutas/i.test(o))
    || opts.find(o => /job (board|site|search)|online (job|posting|board)|job posting/i.test(o) && !narrow.test(o))
    || opts.find(o => /^(internet|online|web)\b/i.test(o.trim()) && !narrow.test(o))
    || opts.find(o => /^other\b/i.test(o.trim()));
  return pick ? { action: field.type === 'select' || field.type === 'radio' ? 'select' : 'click_then_type', value: pick, evidence }
    : { action: 'skip', value: undefined, evidence };
}

function educationAnswer(field: FillField, ctx: TruthContext): Pick<FillAction, 'action' | 'value' | 'evidence'> | null {
  const e = highestEducation(ctx.resume);
  if (!e) {return null;}
  const label = field.label || '';
  if (/high school|ged\b|diploma/i.test(label) && looksYesNo(field)) {return { ...yesNoAction(field, true), evidence: e.evidence };}
  if (field.options?.length) {
    const key = e.level.split(/['\s]/)[0].toLowerCase();  // doctorate | master | bachelor | associate | high
    const pick = field.options.find(o => o.toLowerCase().includes(key === 'doctorate' ? 'doctor' : key))
      || (key === 'doctorate' ? field.options.find(o => /ph\.?d/i.test(o)) : undefined);
    return pick ? { action: field.type === 'select' ? 'select' : 'click_then_type', value: pick, evidence: e.evidence } : null;
  }
  return { action: 'type', value: e.level, evidence: e.evidence };
}

/**
 * The AI's quote when it really is in the candidate's resume (resume text, roles, skills), else
 * null. Wording may differ a little (the parsed text loses punctuation), so most of the quote's
 * words must appear in one place: at least 80% of its words of three letters or more.
 */
export function backedByResume(evidence: string | undefined, ctx: TruthContext): string | null {
  const quote = String(evidence ?? '').trim().replace(/^["'“]|["'”]$/g, '');
  const words = norm(quote).split(' ').filter(w => w.length >= 3);
  if (words.length < 1) {return null;}
  const corpus = [ctx.resume.text, ...ctx.resume.positions.flatMap(p => [p.title, p.company, p.duration, ...p.lines]), ...(ctx.skills ?? [])]
    .map(t => norm(String(t ?? ''))).filter(Boolean);
  const whole = ` ${corpus.join(' ')} `;
  if (whole.includes(` ${norm(quote)} `)) {return quote.slice(0, 160);}
  // A short quote must appear as written: one long word ("sales") proves nothing.
  if (words.length < 3) {return null;}
  const best = Math.max(0, ...corpus.map(c => { const set = new Set(c.split(' ')); return words.filter(w => set.has(w)).length / words.length; }));
  return best >= 0.8 ? quote.slice(0, 160) : null;
}

/** An answer to a fact from the candidate's own data, or null when only they can give it. */
function computed(field: FillField, fact: Fact, ctx: TruthContext): Pick<FillAction, 'action' | 'value' | 'evidence'> & { source: FillSource } | null {
  const tag = (a: Pick<FillAction, 'action' | 'value' | 'evidence'> | null, source: FillSource) => (a ? { ...a, source } : null);
  switch (fact) {
    case 'years_experience': return tag(yearsAnswer(field, ctx), 'resume');
    case 'prior_employment': return tag(priorEmployment(field, ctx), 'resume');
    case 'residence': return tag(residenceAnswer(field, ctx), 'profile');
    case 'time_zone': return tag(timeZoneAnswer(field, ctx), 'profile');
    case 'education_level': return tag(educationAnswer(field, ctx), 'resume');
    case 'work_history': {
      const w = workHistoryValue(ctx.resume, field.label || '');
      if (!w) {return null;}
      const pick = field.options?.length ? field.options.find(o => norm(o) === norm(w.value)) : w.value;
      return pick ? { action: field.options?.length ? 'click_then_type' : 'type', value: pick, evidence: w.evidence, source: 'resume' } : null;
    }
    default: return null;
  }
}

/** A saved answer applied to the field, never flipped by the AI's wording of it. */
function savedAnswer(field: FillField, fact: Fact, saved: string, ai?: FillAction): Pick<FillAction, 'action' | 'value'> {
  if (YES_NO_FACTS.has(fact) && (saved === 'yes' || saved === 'no')) {
    const want = saved === 'yes';
    const v = ai?.value;
    if (ai && ai.action !== 'skip' && ((want && isYes(v)) || (!want && isNo(v)))) {return { action: ai.action, value: v };}
    return yesNoAction(field, want);
  }
  const words = fact === 'clearance' ? (CLEARANCE_LABEL[saved] || saved) : saved;
  if (field.options?.length) {
    // The AI maps the saved words onto the form's options; keep its pick when it has one.
    if (ai && ai.action !== 'skip' && ai.value) {return { action: ai.action, value: ai.value };}
    const pick = field.options.find(o => norm(o) === norm(words)) || field.options.find(o => norm(o).includes(norm(words)));
    return { action: field.type === 'select' ? 'select' : 'click_then_type', value: pick ?? words };
  }
  return { action: 'type', value: words };  // typed facts use the saved words as they are
}

/**
 * Keep only actions whose values have a source; tag each one. Facts without a source are
 * dropped and listed as needs-you; essays are kept as drafts.
 */
export function enforceTruth(actions: FillAction[], fields: FillField[], ctx: TruthContext): { actions: FillAction[]; needsYou: NeedsYou[] } {
  const byId = new Map(fields.map(f => [f.id, f]));
  const aiFor = new Map<string, FillAction>();
  for (const a of actions) {if (byId.has(a.fieldId) && !aiFor.has(a.fieldId)) {aiFor.set(a.fieldId, a);}}
  const kept: FillAction[] = [];
  const needsYou: NeedsYou[] = [];
  const needs = (field: FillField, fact: Fact | 'essay') => {
    const saveAs = fact === 'essay' ? undefined : STATED_KEY[fact as Fact];
    // Another question worth keeping word for word: short-answer, not a follow-up, not about this employer.
    const label = field.label || '';
    const saveKey = fact === 'other' && !FOLLOW_UP.test(label) && field.type !== 'textarea' && labelKey(label).length >= 8
      && !(ctx.jobCompany && labelKey(label).includes(labelKey(ctx.jobCompany))) ? labelKey(label) : undefined;
    needsYou.push({ fieldId: field.id, label: label.trim().slice(0, 140) || field.name || field.id, fact, ...(saveAs ? { saveAs } : {}), ...(saveKey ? { saveKey } : {}) });
  };

  for (const field of fields) {
    if (field.type === 'hidden') {continue;}
    const ai = aiFor.get(field.id);
    const label = field.label || '';
    if (field.type === 'file') { if (ai) {kept.push({ ...ai, source: sourceOf(field, ai) });} continue; }

    if (HOW_HEARD.test(label)) {
      const a = howHeardAnswer(field);
      if (a.action !== 'skip') {kept.push({ fieldId: field.id, ...a, source: 'default' });} else if (field.required) {needs(field, 'other');}
      continue;
    }

    const fact = factOf(field, ctx.topics);
    if (fact && PER_JOB.has(fact)) { needs(field, fact); continue; }
    if (fact) {
      const key = STATED_KEY[fact];
      const saved = key ? (ctx.stated[key] || '').trim() : '';
      if (saved) { kept.push({ fieldId: field.id, ...savedAnswer(field, fact, saved, ai), source: 'answer' }); continue; }
      const c = computed(field, fact, ctx);
      if (c) { kept.push({ fieldId: field.id, ...c }); continue; }
      needs(field, fact);
      continue;
    }

    if (FOLLOW_UP.test(label)) { if (field.required) {needs(field, 'other');} continue; }

    // A question the candidate answered on an earlier form and chose to keep, word for word.
    const kept0 = ctx.custom?.[labelKey(label)];
    if (kept0 && !isEssay(field)) {
      const opt = field.options?.length ? field.options.find(o => norm(o) === norm(kept0)) : kept0;
      if (opt) { kept.push({ fieldId: field.id, action: field.options?.length ? (field.type === 'select' || field.type === 'radio' ? 'select' : 'click_then_type') : 'type', value: opt, source: 'answer', evidence: 'Your saved answer to this question' }); continue; }
    }

    if (isEssay(field)) {
      if (ai && ai.action !== 'skip' && ai.value?.trim()) {
        kept.push({ ...ai, source: 'draft', evidence: 'A draft written from your resume and this job. Read and edit it before you submit.' });
      } else if (field.required) {needs(field, 'essay');}
      continue;
    }

    if (OPT_IN.test(label)) {
      const no = field.options?.find(o => isNo(o) || /^(2\.\s*)?no\b|only (want|use)|do not|don'?t|opt[- ]?out|decline/i.test(o));
      if (no || !field.options?.length) {kept.push({ fieldId: field.id, action: field.options?.length ? (field.type === 'select' || field.type === 'radio' ? 'select' : 'click_then_type') : 'skip', value: no, source: 'default', evidence: "Not signed up for messages or job alerts on your behalf" });}
      else if (field.required) {needs(field, 'other');}
      continue;
    }
    if (!ai || ai.action === 'skip') { if (field.required && !ai?.reason?.match(/captcha|signature/i)) {needs(field, 'other');} else if (ai) {kept.push(ai);} continue; }
    if (ABOUT_THE_JOB.test(label)) { kept.push({ ...ai, source: 'default', evidence: 'From this job posting' }); continue; }
    const source = sourceOf(field, ai);
    // No quote, no answer: a claim about the candidate needs a line of their resume behind it.
    if (source === 'resume' && ai.action !== 'upload_resume') {
      // A value that is itself on the resume (a title, an employer, a school) is its own quote; a bare yes/no never is.
      const v = String(ai.value ?? '');
      const quote = backedByResume(ai.evidence, ctx) || (v.length >= 4 && !isYes(v) && !isNo(v) ? backedByResume(v, ctx) : null);
      if (!quote) { if (field.required) {needs(field, 'other');} continue; }
      kept.push({ ...ai, source, evidence: `On your resume: "${quote}"` });
      continue;
    }
    kept.push({ ...ai, source });
  }
  // Actions for ids not in the field list (the AI's own additions) are dropped: nothing to check them against.
  // Every element stays listed, even when a form renders one question as two (a dropdown and
  // its input): the extension shows the question once but watches each element for an answer.
  return { actions: kept, needsYou };
}
