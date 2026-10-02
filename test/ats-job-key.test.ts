/**
 * Every URL here is a real shape from prod job_postings (2026-10-02). The point
 * of the key is that one posting gets one key however its URL is written.
 */
import { describe, it, expect } from 'vitest';
import { atsJobKey, vendorJobId } from '../server/lib/ats-job-key';

describe('vendorJobId', () => {
  it('reads the same Greenhouse id from the board URL and every custom-domain form', () => {
    // ionq's three rows for one opening.
    for (const url of [
      'https://job-boards.greenhouse.io/ionq/jobs/6107289004',
      'https://ionq.com/job?gh_jid=6107289004',
      'https://ionq.com/jobs/6107289004?gh_jid=6107289004',
    ]) {
      expect(vendorJobId('ATS:greenhouse', url)).toBe('6107289004');
    }
  });

  it('handles the other Greenhouse shapes seen in prod', () => {
    expect(vendorJobId('ATS:greenhouse', 'http://boards.greenhouse.io/mobilityware/jobs/4827307?gh_jid=4827307')).toBe('4827307');
    expect(vendorJobId('ATS:greenhouse', 'https://job-boards.eu.greenhouse.io/altamiratechnologies/jobs/4849799101')).toBe('4849799101');
    expect(vendorJobId('ATS:greenhouse', 'https://coreweave.com/careers/job?4380852006&board=coreweave&gh_jid=4380852006')).toBe('4380852006');
    expect(vendorJobId('ATS:greenhouse', 'https://jobs.elastic.co/jobs?gh_jid=6907907&gh_jid=6907907')).toBe('6907907');
  });

  it('reads each other vendor', () => {
    expect(vendorJobId('ATS:lever', 'https://jobs.lever.co/acme/C6510C38-A082-4D6B-8872-4645071543F3/apply'))
      .toBe('c6510c38-a082-4d6b-8872-4645071543f3');
    expect(vendorJobId('ATS:ashby', 'https://jobs.ashbyhq.com/0x/c6510c38-a082-4d6b-8872-4645071543f3'))
      .toBe('c6510c38-a082-4d6b-8872-4645071543f3');
    expect(vendorJobId('ATS:smartrecruiters', 'https://jobs.smartrecruiters.com/sandisk/744000150559452')).toBe('744000150559452');
    expect(vendorJobId('ATS:breezy', 'https://360dialog.breezy.hr/p/308c999bbd6b-qa-automation-engineer')).toBe('308c999bbd6b');
    expect(vendorJobId('ATS:workable', 'https://apply.workable.com/j/0048DE2F6F')).toBe('0048de2f6f');
    expect(vendorJobId('ATS:recruitee', 'https://accenture.recruitee.com/o/sales-executive')).toBe('sales-executive');
  });

  it('returns null for a URL without an id, or an unknown vendor', () => {
    expect(vendorJobId('ATS:greenhouse', 'https://acme.com/careers')).toBeNull();
    expect(vendorJobId('career_page', 'https://acme.com/jobs/123')).toBeNull();
    expect(vendorJobId('ATS:lever', null)).toBeNull();
  });
});

describe('atsJobKey', () => {
  it('gives every URL form of one posting the same key', () => {
    const keys = new Set([
      'https://job-boards.greenhouse.io/ionq/jobs/6107289004',
      'https://ionq.com/job?gh_jid=6107289004',
    ].map(u => atsJobKey('ATS:greenhouse', 'ionq', u)));
    expect([...keys]).toEqual(['ionq::6107289004']);
  });

  it('scopes the id to the company (ids collide across companies in prod)', () => {
    const url = 'https://x.recruitee.com/o/sales-executive';
    expect(atsJobKey('ATS:recruitee', 'acme', url)).not.toBe(atsJobKey('ATS:recruitee', 'globex', url));
  });

  it('falls back to the URL when it carries no id', () => {
    expect(atsJobKey('ATS:greenhouse', 'acme', 'https://acme.com/careers')).toBe('https://acme.com/careers');
  });
});
