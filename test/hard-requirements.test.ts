/**
 * Hard requirements and the Apply / Stretch / Skip verdict. Phrasings are
 * taken from real postings in the feed (measured on 1,500, 2026-10-04).
 */
import { describe, it, expect } from 'vitest';
import { extractHardRequirements as x, verdictFor, yearsFromPositions, descriptionToText } from '../server/lib/hard-requirements';

describe('extractHardRequirements', () => {
  it('reads clearances, ranking the highest and ignoring "preferred"', () => {
    expect(x('<li>Active TS/SCI with polygraph clearance.</li>').clearance).toBe('ts_sci');
    expect(x('&lt;p&gt;&lt;strong&gt;Clearance required: Active Secret Clearance required&lt;/strong&gt;&lt;/p&gt;').clearance).toBe('secret');
    expect(x('Required: Top Secret clearance with eligibility for SCI').clearance).toBe('ts_sci');
    expect(x('Active Secret clearance preferred.').clearance).toBeNull();
  });

  it('does not mistake descriptions of the work for a requirement', () => {
    expect(x('You will help protect critical TS/SCI networks by monitoring alerts.').clearance).toBeNull();
    expect(x('Cities rely on our platform to build public trust.').clearance).toBeNull();
    expect(x('This position requires a Public Trust clearance.').clearance).toBe('public_trust');
  });

  it('separates "able to obtain" from holding a clearance', () => {
    const r = x('<li>Must be able to obtain and maintain a Secret clearance</li>');
    expect(r.clearance).toBeNull();
    expect(r.clearanceObtainable).toBe(true);
  });

  it('keeps "U.S." intact so citizenship requirements are found', () => {
    expect(x('<li>Must be a U.S. citizen.</li>').usCitizen).toBe(true);
    expect(x('U.S. Citizenship is required for this position.').usCitizen).toBe(true);
  });

  it('reads "citizen or permanent resident" as US person, not citizens only', () => {
    const r = x('Under ITAR, employees must be a U.S. citizen, lawful permanent resident of the U.S., or protected individual.');
    expect(r.usCitizen).toBe(false);
    expect(r.usPerson).toBe(true);
  });

  it('reads no-sponsorship statements', () => {
    for (const s of ['Visa sponsorship is not available for this role.', 'We do not provide immigration sponsorship for this position.', 'No visa sponsorship available.', 'TDI is unable to sponsor an employment visa at this time.']) {
      expect(x(s).noSponsorship).toBe(true);
    }
    expect(x('We offer visa sponsorship for qualified candidates.').noSponsorship).toBe(false);
  });

  it('takes the highest required years, ignoring preferred ones', () => {
    expect(x('<li>3+ years of experience in support</li><li>5+ years of experience with networking</li>').minYears).toBe(5);
    expect(x('Minimum of 2 years in a help desk role.').minYears).toBe(2);
    expect(x('7+ years of experience preferred.').minYears).toBeNull();
  });

  it('decodes doubly escaped HTML', () => {
    expect(descriptionToText('&amp;lt;li&amp;gt;A&amp;amp;B&amp;lt;/li&amp;gt;').trim()).toBe('A&B');
  });
});

const none = { clearance: null, clearanceObtainable: false, usCitizen: false, usPerson: false, noSponsorship: false, minYears: null };

describe('verdictFor', () => {
  it('skips what the candidate said rules them out', () => {
    expect(verdictFor({ ...none, clearance: 'secret' }, { securityClearance: 'none' }, 80).label).toBe('skip');
    expect(verdictFor({ ...none, usCitizen: true }, { usCitizen: 'no' }, 80).label).toBe('skip');
    expect(verdictFor({ ...none, noSponsorship: true }, { needsSponsorship: 'yes' }, 80).label).toBe('skip');
    expect(verdictFor({ ...none, usPerson: true }, { usCitizen: 'no', needsSponsorship: 'yes' }, 80).label).toBe('skip');
  });

  it('never treats an unanswered question as a no', () => {
    const v = verdictFor({ ...none, clearance: 'top_secret', usCitizen: true }, {}, 80);
    expect(v.label).toBe('apply');
    expect(v.toCheck).toEqual(['Requires an active Top Secret clearance', 'Requires US citizenship']);
  });

  it('lets a green-card holder through a US-person requirement', () => {
    expect(verdictFor({ ...none, usPerson: true }, { usCitizen: 'no', needsSponsorship: 'no' }, 80).label).toBe('apply');
  });

  it('treats Public Trust as a stretch, never a skip', () => {
    const v = verdictFor({ ...none, clearance: 'public_trust' }, { securityClearance: 'none' }, 80);
    expect(v.label).toBe('stretch');
  });

  it('grades experience gaps', () => {
    expect(verdictFor({ ...none, minYears: 5 }, { years: 4 }, 80).label).toBe('stretch');
    expect(verdictFor({ ...none, minYears: 10 }, { years: 4 }, 80).label).toBe('skip');
    expect(verdictFor({ ...none, minYears: 3 }, { years: 6 }, 80).label).toBe('apply');
  });

  it('calls a weak skills fit a stretch', () => {
    expect(verdictFor(none, {}, 45).label).toBe('stretch');
  });
});

describe('yearsFromPositions', () => {
  const now = new Date('2026-10-04');
  it('merges overlapping roles and reads months', () => {
    expect(yearsFromPositions([{ duration: 'August 2021 – Present' }, { duration: 'May 2020 – June 2021' }], now)).toBe(6);
    expect(yearsFromPositions([{ duration: '2019 - 2023' }], now)).toBe(4);
    expect(yearsFromPositions([{ duration: '' }], now)).toBeNull();
  });
});
