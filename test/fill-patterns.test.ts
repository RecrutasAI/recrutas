import { describe, it, expect } from 'vitest';
import { profileKeyFor, cleanFieldLabel } from '../server/lib/fill-patterns';

const all = () => true;
const key = (label: string, extra: { name?: string; id?: string } = {}) => profileKeyFor({ label, ...extra }, all);

describe('profileKeyFor (real labels)', () => {
  it('name fields, including the ones missed on 2026-10-15', () => {
    expect(key('Full legal name')).toBe('fullName');            // Ashby, Coder
    expect(key('Legal First Name✱')).toBe('firstName');         // Lever, Hermeus (2.4.3 sends the mark)
    expect(key('Legal Last Name✱')).toBe('lastName');
    expect(key('Full name✱')).toBe('fullName');
    expect(key('Name*')).toBe('fullName');
    expect(key('Your full name')).toBe('fullName');
    expect(key('First and last name')).toBe('fullName');
    expect(key('Legal name (as on your ID)')).toBe('fullName');
  });
  it('leaves other "name" questions alone', () => {
    expect(key('Preferred name (if applicable)')).toBeNull();
    expect(key('Company name')).toBeNull();
    expect(key('Reference name')).toBeNull();
    expect(key('Nick Name')).toBeNull();
  });
  it('other profile fields still match', () => {
    expect(key('Email✱')).toBe('email');
    expect(key('Phone ✱')).toBe('phone');
    expect(key('LinkedIn URL')).toBe('linkedin');
    expect(key('Location (City)*')).toBe('location');
    expect(key('Current company')).toBe('currentCompany');
    expect(key('Street address')).toBeNull();
  });
  it('a signature date is today (Lever disability form)', () => {
    expect(key('Date')).toBe('todayDate');
    expect(key('Signature date')).toBe('todayDate');
    expect(key('Start date')).toBeNull();
    expect(key('Date of birth')).toBeNull();
  });
  it('only keys the profile has a value for', () => {
    expect(profileKeyFor({ label: 'GitHub' }, k => k !== 'github')).toBeNull();
  });
  it('cleans required marks', () => {
    expect(cleanFieldLabel('  Legal First Name ✱ ')).toBe('legal first name');
    expect(cleanFieldLabel('Name (required)')).toBe('name');
  });
});
