/** The feed's location bonus compares places (shared/places.ts), not text. */
import { describe, it, expect } from 'vitest';
import { scoreJob } from '../server/job-scorer';

const job = (location: string, locationKeys: string[], workType = 'onsite') =>
  ({ title: 'Software Engineer', company: 'Acme', location, locationKeys, workType, skills: ['JavaScript'], description: '' }) as any;
const bonus = (cand: string, j: any) => scoreJob(['JavaScript'], 'mid', j, undefined, ['Software Engineer'], { location: cand }).components.contextBonus;

describe('location bonus', () => {
  it('rewards the same city, then the same state, and never a text coincidence', () => {
    expect(bonus('Seattle, WA', job('Onsite - Seattle', ['seattle|WA', 'state|WA']))).toBe(4);
    expect(bonus('Seattle, WA', job('Bellevue, WA', ['bellevue|WA', 'state|WA']))).toBe(2);
    expect(bonus('WA', job('Bellevue, WA', ['bellevue|WA', 'state|WA']))).toBe(2);
    expect(bonus('WA', job('Honolulu, Hawaii', ['honolulu|HI', 'state|HI']))).toBe(0);
    expect(bonus('WA', job('Washington, DC', ['washington|DC', 'state|DC']))).toBe(0);
    expect(bonus('Seattle, WA', job('Remote - US', ['remote'], 'remote'))).toBe(4);
  });
});
