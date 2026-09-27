import { describe, it, expect } from 'vitest';
import { isJobPostUrl, jobPostUrlSqlCondition } from '../server/lib/job-post-url';

// Real URLs from prod scrape logs (2026-09-27) and live ATS boards.
describe('isJobPostUrl', () => {
  it('accepts Breezy posts whose hex id has no 4-digit run', () => {
    // All three were rejected before the .breezy.hr/p/ rule — ~43% of Breezy supply.
    expect(isJobPostUrl('https://360dialog.breezy.hr/p/308c999bbd6b-qa-automation-engineer')).toBe(true);
    expect(isJobPostUrl('https://abc-imaging.breezy.hr/p/79da2cd6f9bd-accountant')).toBe(true);
    expect(isJobPostUrl('https://aai.breezy.hr/p/924c6b10bad3-marketing-and-brand-specialist-entry-level')).toBe(true);
  });

  it('accepts a Greenhouse custom-domain post with a query but no path', () => {
    expect(isJobPostUrl('https://careers.whop.com?gh_jid=5179276007')).toBe(true);
    expect(isJobPostUrl('https://careers.whop.com/?gh_jid=5179276007')).toBe(true);
  });

  it('still accepts the existing ATS shapes', () => {
    for (const u of [
      'https://job-boards.greenhouse.io/databricks/jobs/8123456002',
      'https://jobs.lever.co/palantir/3f1c9a2e-2c4b-4d8e-9a8f-1b2c3d4e5f60',
      'https://jobs.ashbyhq.com/openai/0b0f5c1e-7a1b-4c2d-9e3f-4a5b6c7d8e9f',
      'https://bunq.recruitee.com/o/backend-engineer',
      'https://apply.workable.com/j/AB12CD34EF',
      'https://jobs.smartrecruiters.com/BoschGroup/744000081234567',
    ]) expect(isJobPostUrl(u), u).toBe(true);
  });

  it('rejects homepages and careers landings, including on ATS hosts', () => {
    for (const u of [
      null, undefined, '',
      'https://acme.com', 'https://acme.com/', 'https://acme.com?utm_source=x', 'https://acme.com/?utm_source=x',
      'https://acme.com/careers', 'https://acme.breezy.hr', 'https://acme.breezy.hr/', 'https://acme.breezy.hr/careers',
      'https://www.linkedin.com/company/acme',
    ]) expect(isJobPostUrl(u), String(u)).toBe(false);
  });
});

describe('jobPostUrlSqlCondition', () => {
  it('builds the rule over the given column with inlined patterns', () => {
    const cond = jobPostUrlSqlCondition('external_url');
    expect(cond).toContain('external_url IS NOT NULL');
    expect(cond).toContain(`external_url ~ '^https?://[^/?#]+/?$'`);
    expect(cond).toContain('\\.breezy\\.hr/p/');
    // The null check plus four pattern tests, and no bind parameters.
    expect(cond.match(/external_url/g)).toHaveLength(5);
    expect(cond).not.toMatch(/\$\d/);
  });
});
