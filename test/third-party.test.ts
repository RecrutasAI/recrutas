/**
 * Third-party listings: job boards by source, staffing agencies by name. Everything else is direct.
 */
import { describe, it, expect } from 'vitest';
import { thirdPartyKind, THIRD_PARTY_COMPANIES } from '../server/lib/third-party';

describe('thirdPartyKind', () => {
  it('labels job boards by source and agencies by name, case-insensitively', () => {
    expect(thirdPartyKind({ source: 'Adzuna', company: 'Kaiser' })).toBe('job_board');
    expect(thirdPartyKind({ source: 'ATS:smartrecruiters', company: 'Integrated Resources INC' })).toBe('agency');
    expect(thirdPartyKind({ source: 'ATS:smartrecruiters', company: ' Collabera ' })).toBe('agency');
    expect(thirdPartyKind({ source: 'ATS:lever', company: 'jobgether' })).toBe('agency');
  });

  it('leaves real employers alone, including ones whose posts mention "our clients"', () => {
    for (const company of ['AECOM', 'Stantec', 'Nagarro', 'CACI', 'ProSidian Consulting, LLC', 'Kaiser Permanente']) {
      expect(thirdPartyKind({ source: 'ATS:workday', company })).toBeNull();
    }
  });

  it('keeps every name lowercase, since the feed compares lower(company)', () => {
    for (const name of THIRD_PARTY_COMPANIES) {expect(name).toBe(name.toLowerCase());}
  });
});
