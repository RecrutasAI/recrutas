/**
 * Hard requirements and the Apply / Stretch / Skip verdict. Phrasings are
 * taken from real postings in the feed (measured on 1,500, 2026-10-04).
 */
import { describe, it, expect } from 'vitest';
import { extractHardRequirements as x, verdictFor, yearsFromPositions, descriptionToText } from '../server/lib/hard-requirements';

describe('extractHardRequirements', () => {
  // Audit of 100 real postings, 2026-10-11: each line below was read wrong before.
  it('reads the lowest clearance when either one qualifies', () => {
    expect(x('Active secret or top secret clearance within the last 5 years').clearance).toBe('secret');
    expect(x('Active Secret or TS/SCI clearance required.').clearance).toBe('secret');
    expect(x('This position requires an active DoD Top Secret SCI security clearance.').clearance).toBe('ts_sci');
    expect(x('US citizenship with Active or Current (within 2 years of active) Top Secret Security Clearance with SCI eligibility').clearance).toBe('ts_sci');
    expect(x('Active Top Secret security clearance required.').clearance).toBe('top_secret');
  });

  it('reads "desire to obtain" a clearance as obtaining one, not holding it', () => {
    const r = x('Desire to obtain and hold a US Secret security clearance');
    expect(r.clearance).toBeNull();
    expect(r.clearanceObtainable).toBe(true);
  });

  it('counts ITAR only when it restricts who can do the job', () => {
    expect(x('Contractual knowledge in ITAR and EAR applications regarding product technicalities').usPerson).toBe(false);
    expect(x('Learn more about the ITAR here.').usPerson).toBe(false);
    expect(x('This position requires use of information which is subject to the International Traffic in Arms Regulations (ITAR).').usPerson).toBe(true);
    expect(x('This position supports a federal contract which requires that all employees and job applicants hold a valid Green Card or U.S. Citizenship at the time of application.').usPerson).toBe(true);
  });

  it('reads more ways of saying no sponsorship', () => {
    for (const s of ['This role is not eligible for visa sponsorship.',
      'The company does not offer employment-based visa sponsorship for this role or any other position, now or in the future.',
      'All applicants must be authorized to work in the US without sponsorship.',
      'Applicants for employment in the US must have work authorization that does not now or in the future require sponsorship of a visa for employment authorization in the United States.',
      'Candidates cannot require sponsorship now or in the future']) {
      expect(x(s).noSponsorship, s).toBe(true);
    }
  });

  it('does not apply a sponsorship rule the posting limits to other roles', () => {
    expect(x('Please note we are unable to sponsor or take over sponsorship of an employment visa for roles outside of engineering and product at this time.').noSponsorship).toBe(false);
    expect(x('Visa sponsorship is available for this position.').noSponsorship).toBe(false);
    expect(x('Any offer of employment may be conditioned on your authorization to receive software or technology controlled under these US export laws without sponsorship for an export license.').noSponsorship).toBe(false);
    expect(x('We do sponsor and take over sponsorship of employment visas for this role.').noSponsorship).toBe(false);
    expect(x('Company-sponsored virtual events and happy hours.').noSponsorship).toBe(false);
    expect(x('We prohibit discrimination based on age, citizenship status, marital status or disability.').usPerson).toBe(false);
  });

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
