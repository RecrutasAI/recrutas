/**
 * Truthful autofill: facts are never guessed.
 *
 * A fact (work authorization, sponsorship, citizenship, age, clearance, relocation, start
 * date, salary, years of experience) is answered only from the candidate's own saved answer
 * or, for years of experience, from the resume. Anything else comes back as "needs you".
 * Every action carries where its value came from, so the extension can show it and the
 * candidate can check it before submitting. Enforced here, after the AI, so a model that
 * ignores the prompt still can't put a guess on a form.
 */

export type FillSource = 'profile' | 'resume' | 'answer' | 'default';
export type Fact =
  | 'sponsorship' | 'work_auth' | 'citizenship' | 'over18' | 'clearance'
  | 'relocation' | 'start_date' | 'salary' | 'years_experience';

export interface FillField { id: string; label?: string; name?: string; type?: string; options?: string[] }
export interface FillAction { fieldId: string; action: string; value?: string; reason?: string; source?: FillSource; evidence?: string }
export interface NeedsYou { fieldId: string; label: string; fact: Fact }

/** Order matters: "require visa sponsorship to work in the US" is about sponsorship, not authorization. */
const FACTS: Array<[Fact, RegExp]> = [
  ['sponsorship', /sponsor|\bvisa\b|\bh-?1b\b/i],
  ['work_auth', /(legally |lawfully )?(authori[sz]ed|eligible|permitted|right) to work|work authori[sz]ation|without restriction/i],
  ['citizenship', /\bu\.?s\.? citizen|citizen of the united states|citizenship/i],
  ['over18', /(at least|over|older than) (18|eighteen)|18 years of age|age of 18/i],
  ['clearance', /security clearance|\bclearance\b|\bts\/sci\b|top secret/i],
  ['relocation', /relocat/i],
  ['start_date', /notice period|earliest (start|available)|when can you start|start date|available to start/i],
  ['salary', /salary|compensation|expected pay|desired pay|pay expectation|hourly rate|rate expectation/i],
  ['years_experience', /\byears? of (\w+ )*experience|\d+\+? (or more )?years|how many years/i],
];

export function factOf(field: FillField): Fact | null {
  const text = `${field.label || ''} ${field.name || ''}`.replace(/\s+/g, ' ');
  for (const [fact, re] of FACTS) {if (re.test(text)) {return fact;}}
  return null;
}

/** The candidate's saved answers (Settings → Application answers), keyed as stored. */
export type Stated = Partial<Record<'workAuthorizedUS' | 'needsSponsorship' | 'usCitizen' | 'over18' | 'securityClearance' | 'willingToRelocate' | 'noticePeriod' | 'desiredSalary', string>>;

const STATED_KEY: Partial<Record<Fact, keyof Stated>> = {
  sponsorship: 'needsSponsorship', work_auth: 'workAuthorizedUS', citizenship: 'usCitizen', over18: 'over18',
  clearance: 'securityClearance', relocation: 'willingToRelocate', start_date: 'noticePeriod', salary: 'desiredSalary',
};
const CLEARANCE_LABEL: Record<string, string> = { none: 'None', public_trust: 'Public Trust', secret: 'Secret', top_secret: 'Top Secret', ts_sci: 'TS/SCI' };
const YES_NO_FACTS = new Set<Fact>(['sponsorship', 'work_auth', 'citizenship', 'over18', 'relocation']);

const PROFILE_FIELD = /first[\s_-]?name|last[\s_-]?name|full[\s_-]?name|^name\b|e-?mail|phone|mobile|linkedin|github|portfolio|website|\bcity\b|location|country|state|address|zip|postal/i;
const DEFAULT_FIELD = /gender|race|ethnic|hispanic|latino|veteran|disability|pronoun|how did you hear|referral source|^source$|confirm|acknowledge|certify|consent|i agree|privacy|terms/i;

function sourceOf(field: FillField, action: FillAction): FillSource {
  if (action.action === 'upload_resume') {return 'resume';}
  const text = `${field.label || ''} ${field.name || ''}`;
  if (DEFAULT_FIELD.test(text)) {return 'default';}
  if (PROFILE_FIELD.test(text)) {return 'profile';}
  return 'resume';
}

const isYes = (v = '') => /^\s*(yes|y|true|i am|i do|i will|i have)\b/i.test(v);
const isNo = (v = '') => /^\s*(no|n|false|i am not|i do not|i don'?t|i will not|i won'?t)\b/i.test(v);

/**
 * Keep only actions whose values have a source; tag each one. Facts without a saved answer
 * (or resume evidence for years of experience) are dropped and listed as needs-you.
 */
export function enforceTruth(
  actions: FillAction[], fields: FillField[], stated: Stated, resume: { totalYears?: number | string | null },
): { actions: FillAction[]; needsYou: NeedsYou[] } {
  const byId = new Map(fields.map(f => [f.id, f]));
  const kept: FillAction[] = [];
  const needsYou: NeedsYou[] = [];
  const flagged = new Set<string>();
  const needs = (field: FillField, fact: Fact) => {
    if (flagged.has(field.id)) {return;}
    flagged.add(field.id);
    needsYou.push({ fieldId: field.id, label: (field.label || field.name || field.id).trim().slice(0, 140), fact });
  };

  for (const a of actions) {
    const field = byId.get(a.fieldId);
    if (!field) {continue;}
    const fact = factOf(field);
    if (a.action === 'skip') {
      if (fact) {needs(field, fact);} else {kept.push(a);}
      continue;
    }
    if (!fact) { kept.push({ ...a, source: sourceOf(field, a) }); continue; }

    if (fact === 'years_experience') {
      const years = Number(resume.totalYears);
      if (Number.isFinite(years) && years > 0) {
        kept.push({ ...a, source: 'resume', evidence: `About ${years} year${years === 1 ? '' : 's'} of experience on your resume` });
      } else {needs(field, fact);}
      continue;
    }

    const key = STATED_KEY[fact];
    const saved = key ? (stated[key] || '').trim() : '';
    if (!saved) { needs(field, fact); continue; }
    let value = a.value;
    if (YES_NO_FACTS.has(fact) && (saved === 'yes' || saved === 'no')) {
      // The AI maps the saved answer onto the form's wording; never let it flip the answer.
      const want = saved === 'yes';
      if ((want && isNo(value)) || (!want && isYes(value)) || (!isYes(value) && !isNo(value))) {
        const opts = field.options || [];
        value = (want ? opts.find(o => isYes(o)) : opts.find(o => isNo(o))) || (want ? 'Yes' : 'No');
      }
    }
    if (!YES_NO_FACTS.has(fact) && a.action === 'type') {
      value = fact === 'clearance' ? (CLEARANCE_LABEL[saved] || saved) : saved;  // typed facts use the saved words as they are
    }
    kept.push({ ...a, value, source: 'answer' });
  }

  // Required facts the AI left out entirely also need the candidate.
  const covered = new Set(kept.map(a => a.fieldId));
  for (const f of fields) {
    if (covered.has(f.id) || flagged.has(f.id) || f.type === 'file' || f.type === 'hidden') {continue;}
    const fact = factOf(f);
    if (fact && (f as any).required) {needs(f, fact);}
  }
  return { actions: kept, needsYou };
}
