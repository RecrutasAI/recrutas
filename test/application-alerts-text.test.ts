import { describe, it, expect, vi } from 'vitest';
vi.mock('../server/db', () => ({ db: {} }));
import { alertText, type ApplicationAlert } from '../server/services/application-alerts.service';
import { applicationUpdatesDigestEmail } from '../server/lib/email';

const base: ApplicationAlert = {
  kind: 'closed', applicationId: 1, candidateId: 'u', jobId: 9,
  title: 'Senior IT Support Specialist ', company: 'rocket lab',
  appliedAt: new Date('2026-09-20T12:00:00Z'), closedAt: new Date('2026-10-02T12:00:00Z'),
};

describe('application alert copy', () => {
  it('says a closed job was taken down, with dates and a capitalized company', () => {
    const t = alertText(base);
    expect(t.title).toBe('Senior IT Support Specialist at Rocket Lab was taken down');
    expect(t.message).toContain('You applied on Sep 20');
    expect(t.message).toContain('on Oct 2');
  });

  it('describes a repost without claiming the candidate was rejected', () => {
    const t = alertText({ ...base, kind: 'reposted', repostedAt: new Date('2026-10-03T12:00:00Z') });
    expect(t.title).toBe('Rocket Lab reposted a role you applied to');
    expect(t.message).toContain('still looking');
    expect(t.message).not.toMatch(/reject/i);
  });

  it('keeps a mixed-case company name as stored', () => {
    expect(alertText({ ...base, company: 'PubMatic' }).title).toContain('at PubMatic');
  });
});

describe('digest email', () => {
  it('escapes job data', () => {
    const html = applicationUpdatesDigestEmail('Ada <b>', [{ kind: 'closed', title: 'Eng <script>x</script>', message: 'a & b' }]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('Hi Ada,');
  });
});
