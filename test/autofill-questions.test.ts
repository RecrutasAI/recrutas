/**
 * Application questions sorted by what they ask, and answered only from what the candidate owns.
 * Every label below is a real one from live Greenhouse jobs (2026-10-12).
 */
import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { enforceTruth, factOf, yearsSubject, type FillField, type Stated, type TruthContext } from '../server/lib/autofill-truth';
import { durationRange, highestEducation, resumeFacts, yearsCovered, yearsWith, type ResumeFacts } from '../server/lib/resume-facts';
import { buildPlaceIndex } from '../shared/places';

const data = JSON.parse(readFileSync('client/public/us-places.json', 'utf8'));
const places = buildPlaceIndex(data.places.map(([n, s, c]: [string, string, number]) => ({ n, s, c })));
const NOW = new Date('2026-10-12T12:00:00Z');

const ctx = (stated: Stated = {}, resume: Partial<ResumeFacts> = {}, more: Partial<TruthContext> = {}): TruthContext =>
  ({ stated, resume: { positions: [], companies: [], totalYears: null, text: '', ...resume }, places, ...more });
const yn = ['Yes', 'No'];
const q = (label: string, extra: Partial<FillField> = {}): FillField => ({ id: label.slice(0, 20), label, type: 'custom_select', options: yn, required: true, ...extra });
const one = (field: FillField, c: TruthContext, ai?: { action: string; value?: string }) =>
  enforceTruth(ai ? [{ fieldId: field.id, ...ai }] : [], [field], c);

describe('factOf on real wordings', () => {
  it.each([
    ['Do you currently hold a valid driver’s license?', 'drivers_license'],
    ["Do you currently hold a valid driver's license?", 'drivers_license'],
    ['Are you able to safely lift up to 100 pounds?', 'physical'],
    ['Have you had any driving violations/tickets within the last three years?', 'criminal_history'],
    ['Have you been interviewed by Conga before?', 'prior_application'],
    ['Did a current Comstock/ParkX Employee refer you to this position?', 'referral'],
    ["Referee's Name", 'referral'],
    ['Are you the parent, guardian, spouse, sibling, or child of a current or former patient at Compass Health Center?', 'relatives'],
    ['Do you reside in Las Vegas, NV or the surrounding area?', 'residence'],
    ['What city do you live in?', 'residence'],
    ['Please select your time zone:', 'time_zone'],
    ['Are you within a commutable distance from the office location?', 'commute'],
    ['What languages are you fluent in?', 'languages'],
    ['What is your highest level of education?', 'education_level'],
    ['Do you have at least a high school diploma or equivalent (i.e. GED)?', 'education_level'],
    ['Are you able to attend in-person company offsites twice a year?', 'schedule'],
    ['When is your earliest availability to start this new position?', 'start_date'],
    ['Have you ever been convicted of a felony?', 'criminal_history'],
  ])('%s → %s', (label, fact) => {
    expect(factOf({ id: 'x', label })).toBe(fact);
  });
});

describe('per-job facts are the candidate’s, even when the AI answers them', () => {
  it.each([
    'Are you able to safely lift up to 100 pounds?',
    'Have you been interviewed by Conga before?',
    'Did a current Comstock/ParkX Employee refer you to this position?',
    'Have you ever been convicted of a felony?',
  ])('%s', label => {
    const { actions, needsYou } = one(q(label), ctx(), { action: 'select', value: 'No' });
    expect(actions).toEqual([]);
    expect(needsYou).toHaveLength(1);
    expect(needsYou[0].saveAs).toBeUndefined();   // never saved: true for this job only
  });

  it('follow-up questions wait for the candidate, never an AI draft', () => {
    const f = q('If yes, please explain the circumstances for each occasion.', { type: 'textarea', options: undefined });
    const { actions, needsYou } = one(f, ctx(), { action: 'type', value: 'I have never been…' });
    expect(actions).toEqual([]);
    expect(needsYou.map(n => n.fact)).toEqual(['other']);
  });
});

describe('saved facts', () => {
  it('a guessed driver’s license is dropped, and the needs-you says where to save it', () => {
    const f = q('Do you currently hold a valid driver’s license?');
    const { actions, needsYou } = one(f, ctx(), { action: 'select', value: 'Yes' });
    expect(actions).toEqual([]);
    expect(needsYou[0]).toMatchObject({ fact: 'drivers_license', saveAs: 'driversLicense' });
  });
  it('a saved one fills every wording', () => {
    for (const label of ['Do you currently hold a valid driver’s license?', 'Do you have a valid license to drive in your state?']) {
      expect(one(q(label), ctx({ driversLicense: 'no' })).actions[0]).toMatchObject({ value: 'No', source: 'answer' });
    }
  });
});

describe('years of experience', () => {
  const roles = resumeFacts({
    positions: [
      { title: 'Senior Support Engineer', company: 'EEC', duration: 'September 2022 – Present', responsibilities: ['Managed the AWS console', 'Ran Kubernetes clusters'] },
      { title: 'IT Support Specialist', company: 'Acme', duration: 'Jan 2019 - Aug 2022', responsibilities: ['Supported 200 users on Windows'] },
    ],
  }, '', NOW);

  it('finds the subject a years question asks about, or none for experience in general', () => {
    expect(yearsSubject('How many years of experience do you have with Kubernetes?')).toBe('Kubernetes');
    expect(yearsSubject('How many years of Python experience do you have?')).toBe('Python');
    expect(yearsSubject('How many years of professional experience do you have?')).toBeNull();
    expect(yearsSubject('Do you have 2 or more years of professional experience developing software?')).toBeNull();
  });

  it('answers a named skill from the roles that mention it, not from total years', () => {
    const k = one(q('How many years of experience do you have with Kubernetes?', { type: 'text', options: undefined }), ctx({}, roles));
    expect(k.actions[0]).toMatchObject({ value: '4', source: 'resume' });   // Sep 2022 → Oct 2026, rounded down
    expect(k.actions[0].evidence).toMatch(/Senior Support Engineer at EEC/);
  });

  it('asks the candidate when the resume never names the skill (it used to answer with total years)', () => {
    const r = one(q('How many years of experience do you have with Salesforce?', { type: 'text', options: undefined }), ctx({}, roles));
    expect(r.actions).toEqual([]);
    expect(r.needsYou[0].fact).toBe('years_experience');
  });

  it('answers general experience from all dated roles, overlaps once, and picks a range option', () => {
    expect(roles.totalYears).toBe(7);   // Jan 2019 → Oct 2026
    const f = q('How many years of relevant work experience do you have?', { options: ['0-2', '3-5', '6-9', '10+'] });
    expect(one(f, ctx({}, roles)).actions[0]).toMatchObject({ value: '6-9', source: 'resume' });
  });
});

describe('residence and time zone from the profile location', () => {
  const seattle = ctx({}, {}, { location: 'Seattle, WA' });
  it('another state is a no', () => {
    expect(one(q('Do you reside in Las Vegas, NV or the surrounding area?'), seattle).actions[0])
      .toMatchObject({ value: 'No', source: 'profile', evidence: 'Your profile location is Seattle, WA' });
  });
  it('the same place is a yes', () => {
    expect(one(q('Are you currently located in Seattle, WA?'), seattle).actions[0]).toMatchObject({ value: 'Yes', source: 'profile' });
  });
  it('another city in the same state could be a suburb: the candidate answers', () => {
    expect(one(q('Do you live in Tacoma, WA or within 30 miles?'), seattle).needsYou[0].fact).toBe('residence');
  });
  it('a free-text "where do you live" gets the profile location', () => {
    expect(one(q('What city do you live in?', { type: 'text', options: undefined }), seattle).actions[0]).toMatchObject({ value: 'Seattle, WA', source: 'profile' });
  });
  it('time zone from a single-zone state; a split state is the candidate’s', () => {
    const tz = q('Please select your time zone:', { options: ['Eastern (ET)', 'Central (CT)', 'Mountain (MT)', 'Pacific (PT)'] });
    expect(one(tz, seattle).actions[0]).toMatchObject({ value: 'Pacific (PT)', source: 'profile' });
    expect(one(tz, ctx({}, {}, { location: 'Chicago, IL' })).actions[0].value).toBe('Central (CT)');
    // Texas and Idaho span two zones: the candidate's to answer.
    expect(one(tz, ctx({}, {}, { location: 'Austin, TX' })).needsYou[0].fact).toBe('time_zone');
    expect(one(tz, ctx({}, {}, { location: 'Boise, ID' })).needsYou[0].fact).toBe('time_zone');
  });
});

describe('how did you hear about us: the truth is Recrutas, a job board', () => {
  it('picks Recrutas, else a job board option, else Other; never "Company website"', () => {
    expect(one(q('How did you hear about this job?', { options: ['LinkedIn', 'Company website', 'Recrutas', 'Other'] }), ctx()).actions[0].value).toBe('Recrutas');
    expect(one(q('How did you hear about us?', { options: ['Company Website', 'Job Board', 'Referral'] }), ctx(), { action: 'select', value: 'Company Website' }).actions[0])
      .toMatchObject({ value: 'Job Board', source: 'default' });
    expect(one(q('How did you hear about this opportunity?', { type: 'text', options: undefined }), ctx()).actions[0].value).toBe('Recrutas (job board)');
  });
});

describe('essays are drafts', () => {
  it('keeps the AI text, labeled a draft to review', () => {
    const f = q('Why do you want to work at Stripe?', { type: 'textarea', options: undefined });
    expect(one(f, ctx(), { action: 'type', value: 'I ran payments support at…' }).actions[0]).toMatchObject({ source: 'draft' });
  });
});

describe('resume facts', () => {
  it('reads both stored shapes', () => {
    const p = { title: 'Engineer', company: 'Acme', duration: '2020 - 2022', responsibilities: [] };
    expect(resumeFacts({ positions: [p] }).companies).toEqual(['Acme']);
    expect(resumeFacts({ experience: { positions: [p] } }).companies).toEqual(['Acme']);
  });
  it('reads role dates as written', () => {
    expect(durationRange('September 2022 – Present', NOW)).toEqual([2022 * 12 + 8, 2026 * 12 + 10]);
    expect(durationRange('06/2019 - 12/2021')).toEqual([2019 * 12 + 5, 2021 * 12 + 12]);
    expect(durationRange('2018 to 2020')).toEqual([2018 * 12, 2020 * 12 + 12]);
    expect(durationRange('Summer internship')).toBeNull();
  });
  it('counts overlapping roles once and rounds down', () => {
    expect(yearsCovered([[0, 30], [24, 40]])).toBe(3);   // 40 months
  });
  it('finds a skill by whole word only', () => {
    const f = resumeFacts({ positions: [{ title: 'Dev', company: 'A', duration: '2020 - 2021', responsibilities: ['Wrote Javascript'] }] }, '', NOW);
    expect(yearsWith(f, 'Java', NOW)).toBeNull();
    expect(yearsWith(f, 'JavaScript', NOW)?.years).toBe(2);
  });
  it('reads the highest degree, and a state code is not one', () => {
    expect(highestEducation(resumeFacts({}, 'Boston, MA\nB.S. in Computer Science, Northeastern University'))?.level).toBe("Bachelor's degree");
    expect(highestEducation(resumeFacts({}, 'Boston, MA 02115\nSupport lead'))).toBeNull();
  });
});

describe('no quote, no answer', () => {
  const resume = resumeFacts({ positions: [
    { title: 'Account Manager', company: 'Ogilvy', duration: '2020 - 2024', responsibilities: ['Ran full sales cycle from prospecting to close for agency clients'] },
  ] }, 'Certifications: CCure 9000 Certified Technician');
  const c = ctx({}, resume, { skills: ['Salesforce'] });
  const f = q('Do you have agency experience?');

  it('drops a resume answer with no quote', () => {
    const r = one(f, c, { action: 'select', value: 'Yes' });
    expect(r.actions).toEqual([]);
    expect(r.needsYou[0].fact).toBe('other');
  });
  it('drops a quote that is not on the resume', () => {
    expect(one(f, c, { action: 'select', value: 'Yes', evidence: 'Worked at three agencies' } as any).actions).toEqual([]);
  });
  it('keeps an answer whose quote is on the resume, and shows the quote', () => {
    const a = one(f, c, { action: 'select', value: 'Yes', evidence: 'full sales cycle from prospecting to close for agency clients' } as any).actions[0];
    expect(a).toMatchObject({ value: 'Yes', source: 'resume' });
    expect(a.evidence).toMatch(/^On your resume: "/);
  });
  it('a typed value that is itself on the resume counts as its own quote', () => {
    const title = q('Most Recent Job Title', { type: 'text', options: undefined });
    expect(one(title, c, { action: 'type', value: 'Account Manager' }).actions[0]).toMatchObject({ source: 'resume' });
    expect(one(title, c, { action: 'type', value: 'VP of Sales' }).actions).toEqual([]);
  });
  it('a bare yes is never its own quote', () => {
    expect(one(q('Are you CCure Certified?', { type: 'text', options: undefined }), c, { action: 'type', value: 'Yes' }).actions).toEqual([]);
  });
});

describe('opt-ins, restrictions and the job itself', () => {
  it('never opts the candidate into texts or job alerts', () => {
    const sms = q('I would like to receive updates from a recruiter about this job via SMS. Please answer with Yes or No.');
    expect(one(sms, ctx(), { action: 'select', value: 'Yes' }).actions[0]).toMatchObject({ value: 'No', source: 'default' });
    const pool = q('Job Alerts / Future Opportunities Opt-In', { options: ['1. Yes, I would like Azurity to retain my profile and contact me about future job opportunities.', '2. No, I only want my information used for the specific role(s) I apply to'] });
    expect(one(pool, ctx()).actions[0].value).toMatch(/^2\. No/);
  });
  it('non-competes, contracts and discharges are the candidate’s, never guessed or saved', () => {
    for (const label of ['Do you have a non-compete that is currently in effect?', 'Are you presently under an employment contract?', 'Were you discharged or asked to resign?']) {
      const r = one(q(label), ctx(), { action: 'select', value: 'No' });
      expect(r.actions, label).toEqual([]);
      expect(r.needsYou[0].saveAs, label).toBeUndefined();
    }
  });
  it('past or current employee questions are answered from the resume employers', () => {
    const r = one(q('Are you a past employee of Method, VCCP Group or any of its agencies?'), ctx({}, { companies: ['Stripe'] }), { action: 'select', value: 'Yes' });
    expect(r.actions[0]).toMatchObject({ value: 'No', source: 'resume' });
  });
  it('"what position are you applying for" comes from the posting', () => {
    const r = one(q('What is the position you are applying for?', { type: 'text', options: undefined }), ctx(), { action: 'type', value: 'Field Technician' });
    expect(r.actions[0]).toMatchObject({ value: 'Field Technician', source: 'default', evidence: 'From this job posting' });
  });
});

describe('the shared map of wordings', () => {
  it('places a wording the rules miss', () => {
    const f = q('Do you require immigration support either now OR in the future?');
    const topics = new Map([['do you require immigration support either now or in the future', 'sponsorship' as const]]);
    expect(factOf(f)).toBeNull();
    expect(one(f, ctx({ needsSponsorship: 'no' }, {}, { topics })).actions[0]).toMatchObject({ value: 'No', source: 'answer' });
  });
  it('a yes/no fact never lands on a name box, whatever the map says', () => {
    const employer = q('Current/Most recent Employer:', { type: 'text', options: undefined });
    const topics = new Map([['current most recent employer', 'prior_employment' as const]]);
    expect(factOf(employer, topics)).toBeNull();
  });
});
