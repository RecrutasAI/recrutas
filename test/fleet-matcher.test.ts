/**
 * The server side of Fleet matching: anonymous ids and turning a matched Fleet job into
 * the same ingestion input the ATS scrapers produce.
 */
import { describe, it, expect } from 'vitest';
import { pseudonym, toIngestion } from '../scripts/fleet-matcher';

const job = {
  job_id: 'j_abc', title: 'Registered Nurse', company_name: 'Kaiser Permanente', location: 'Oakland, CA',
  description: 'Provide patient care. Epic EHR, BLS required.', url: 'https://jobs.lever.co/kaiser/123', apply_url: null,
  ats: 'lever', posted_at: '2026-10-09T00:00:00Z', is_remote: false, salary_min: 90000, salary_max: 120000, vector: [],
};

describe('fleet matcher (server side)', () => {
  it('gives each user a stable anonymous id that depends on the key', () => {
    expect(pseudonym('user-1', 'k1')).toBe(pseudonym('user-1', 'k1'));
    expect(pseudonym('user-1', 'k1')).not.toBe(pseudonym('user-1', 'k2'));
    expect(pseudonym('user-1', 'k1')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('maps a Fleet job to the same shape the ATS scrapers ingest', () => {
    expect(toIngestion(job)).toMatchObject({
      title: 'Registered Nurse', company: 'Kaiser Permanente', location: 'Oakland, CA', workType: 'onsite',
      source: 'ATS:lever', externalId: 'fleet:j_abc', externalUrl: 'https://jobs.lever.co/kaiser/123',
      salaryMin: 90000, salaryMax: 120000, postedDate: '2026-10-09T00:00:00Z', requirements: [],
    });
  });

  it('marks remote jobs and skips jobs without a link or company', () => {
    expect(toIngestion({ ...job, is_remote: true, location: null })).toMatchObject({ workType: 'remote', location: 'Remote' });
    expect(toIngestion({ ...job, url: null, apply_url: null })).toBeNull();
    expect(toIngestion({ ...job, company_name: null })).toBeNull();
  });
});
