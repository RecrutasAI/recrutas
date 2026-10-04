import { describe, it, expect, vi } from 'vitest';
vi.mock('../server/db', () => ({ db: {} }));
import { canonicalPostingUrl, vendorFromUrl } from '../server/services/application-tracking.service';
import { vendorJobId } from '../server/lib/ats-job-key';

// The extension reports the page the candidate applied from, which can be any
// step of the flow. Each must map to the posting URL the scraper stored.
describe('canonicalPostingUrl', () => {
  it.each([
    ['https://jobs.lever.co/15five/b6a27c02-0e49-415f-892e-b70d2bd45bc1/apply', 'https://jobs.lever.co/15five/b6a27c02-0e49-415f-892e-b70d2bd45bc1'],
    ['https://jobs.lever.co/15five/b6a27c02-0e49-415f-892e-b70d2bd45bc1/thanks', 'https://jobs.lever.co/15five/b6a27c02-0e49-415f-892e-b70d2bd45bc1'],
    ['https://jobs.ashbyhq.com/cohere/bde93d36-4a41-4c8c-bd98-b4e44f9061e4/application?utm_source=x', 'https://jobs.ashbyhq.com/cohere/bde93d36-4a41-4c8c-bd98-b4e44f9061e4'],
    ['https://job-boards.greenhouse.io/okx/jobs/8002221003/confirmation', 'https://job-boards.greenhouse.io/okx/jobs/8002221003'],
    ['https://block.xyz/careers/jobs/4901418008?gh_jid=4901418008&utm=a#top', 'https://block.xyz/careers/jobs/4901418008?gh_jid=4901418008'],
    ['http://acme.breezy.hr/p/308c999bbd6b-qa-engineer/apply/', 'https://acme.breezy.hr/p/308c999bbd6b-qa-engineer'],
  ])('%s', (input, expected) => {
    expect(canonicalPostingUrl(input)).toBe(expected);
  });

  it('rejects garbage', () => {
    expect(canonicalPostingUrl('not a url')).toBeNull();
  });
});

describe('vendorFromUrl', () => {
  it('detects vendors, including Greenhouse on a company domain', () => {
    expect(vendorFromUrl('https://jobs.lever.co/a/b')).toBe('lever');
    expect(vendorFromUrl('https://block.xyz/careers/jobs/1?gh_jid=1')).toBe('greenhouse');
    expect(vendorFromUrl('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/x')).toBe('workday');
    expect(vendorFromUrl('https://example.com/jobs/1')).toBeNull();
  });

  it('keeps the vendor job id readable after canonicalising', () => {
    const c = canonicalPostingUrl('https://jobs.lever.co/15five/b6a27c02-0e49-415f-892e-b70d2bd45bc1/apply')!;
    expect(vendorJobId('lever', c)).toBe('b6a27c02-0e49-415f-892e-b70d2bd45bc1');
  });
});
