/**
 * Truthful autofill: facts come only from the candidate's saved answers (or the resume for
 * years of experience); everything else is tagged with its source.
 */
import { describe, it, expect } from 'vitest';
import { enforceTruth, factOf, type FillField } from '../server/lib/autofill-truth';

// Labels from a real Greenhouse form (honeycomb insurance, 2026-10-10) plus common variants.
const F = {
  first: { id: 'first_name', label: 'First Name*', type: 'text', required: true },
  country: { id: 'country', label: 'Country*', type: 'custom_select', required: true },
  auth: { id: 'q_auth', label: 'Are you authorized to work in the US without restriction? *', type: 'custom_select', options: ['Yes', 'No'], required: true },
  sponsor: { id: 'q_visa', label: 'Do you now or will you in the future require visa sponsorship to work in the US?', type: 'custom_select', options: ['Yes', 'No'], required: true },
  years: { id: 'q_years', label: 'Do you have 2 or more years of professional experience developing software?', type: 'custom_select', options: ['Yes', 'No'], required: true },
  salary: { id: 'q_salary', label: 'What are your salary expectations?', type: 'text' },
  consent: { id: 'q_consent', label: 'I hereby confirm collection and usage of the above information', type: 'custom_select', required: true },
  gender: { id: 'gender', label: 'Gender', type: 'custom_select' },
  why: { id: 'q_why', label: 'Why do you want to work at honeycomb?', type: 'textarea' },
  resume: { id: 'resume', label: 'Resume/CV', type: 'file', required: true },
} satisfies Record<string, FillField & { required?: boolean }>;
const fields = Object.values(F);

describe('factOf', () => {
  it('recognizes fact questions, and sponsorship before authorization', () => {
    expect(factOf(F.auth)).toBe('work_auth');
    expect(factOf(F.sponsor)).toBe('sponsorship');
    expect(factOf(F.years)).toBe('years_experience');
    expect(factOf(F.salary)).toBe('salary');
    expect(factOf({ id: 'x', label: 'Are you legally eligible to work in the United States?' })).toBe('work_auth');
    expect(factOf({ id: 'x', label: 'Are you at least 18 years of age?' })).toBe('over18');
    expect(factOf({ id: 'x', label: 'Do you hold an active security clearance?' })).toBe('clearance');
    expect(factOf({ id: 'x', label: 'Are you willing to relocate to Austin?' })).toBe('relocation');
    expect(factOf({ id: 'x', label: 'When can you start?' })).toBe('start_date');
  });
  it('leaves ordinary fields alone', () => {
    for (const f of [F.first, F.country, F.consent, F.gender, F.why, F.resume]) {expect(factOf(f)).toBeNull();}
  });
});

describe('enforceTruth', () => {
  const aiGuesses = [
    { fieldId: 'first_name', action: 'type', value: 'Ada' },
    { fieldId: 'country', action: 'click_then_type', value: 'United States' },
    { fieldId: 'q_auth', action: 'click_then_type', value: 'Yes' },          // guessed from location
    { fieldId: 'q_salary', action: 'type', value: 'Negotiable' },            // guessed
    { fieldId: 'q_years', action: 'click_then_type', value: 'Yes' },
    { fieldId: 'q_consent', action: 'click_then_type', value: 'Yes' },
    { fieldId: 'gender', action: 'click_then_type', value: 'Decline to self-identify' },
    { fieldId: 'q_why', action: 'type', value: 'I built claims tooling at...' },
    { fieldId: 'resume', action: 'upload_resume' },
  ];

  it('drops guessed facts and lists them as needs-you when nothing is saved', () => {
    const { actions, needsYou } = enforceTruth(aiGuesses, fields, {}, { totalYears: null });
    const ids = actions.map(a => a.fieldId);
    expect(ids).not.toContain('q_auth');
    expect(ids).not.toContain('q_salary');
    expect(ids).not.toContain('q_years');
    expect(needsYou.map(n => n.fact).sort()).toEqual(['salary', 'sponsorship', 'work_auth', 'years_experience']);
    expect(needsYou.find(n => n.fact === 'sponsorship')?.label).toMatch(/visa sponsorship/);
  });

  it('tags every kept value with where it came from', () => {
    const { actions } = enforceTruth(aiGuesses, fields, {}, { totalYears: null });
    const src = Object.fromEntries(actions.map(a => [a.fieldId, a.source]));
    expect(src).toMatchObject({ first_name: 'profile', country: 'profile', q_consent: 'default', gender: 'default', q_why: 'resume', resume: 'resume' });
  });

  it('answers facts from saved answers and never flips them', () => {
    const { actions, needsYou } = enforceTruth(
      [...aiGuesses, { fieldId: 'q_visa', action: 'click_then_type', value: 'Yes' }],   // AI said Yes; candidate said no
      fields, { workAuthorizedUS: 'yes', needsSponsorship: 'no', desiredSalary: '$120,000' }, { totalYears: 6 },
    );
    const by = Object.fromEntries(actions.map(a => [a.fieldId, a]));
    expect(by.q_auth).toMatchObject({ value: 'Yes', source: 'answer' });
    expect(by.q_visa).toMatchObject({ value: 'No', source: 'answer' });
    expect(by.q_salary).toMatchObject({ value: '$120,000', source: 'answer' });   // typed facts use the saved words, not the AI's
    expect(by.q_years).toMatchObject({ source: 'resume', evidence: 'About 6 years of experience on your resume' });
    expect(needsYou).toEqual([]);
  });

  it('turns an AI skip on a fact into needs-you, and keeps other skips', () => {
    const { actions, needsYou } = enforceTruth(
      [{ fieldId: 'q_visa', action: 'skip', reason: 'needs candidate' }, { fieldId: 'q_why', action: 'skip', reason: 'captcha' }],
      [F.sponsor, F.why], {}, {},
    );
    expect(needsYou.map(n => n.fieldId)).toEqual(['q_visa']);
    expect(actions.map(a => a.fieldId)).toEqual(['q_why']);
  });
});
