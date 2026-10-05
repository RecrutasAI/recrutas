import { describe, it, expect, beforeAll } from 'vitest';
import { unsubscribeUrl, verifyUnsubscribe, unsubscribeHeaders } from '../server/lib/unsubscribe';
import { weeklySummaryEmail } from '../server/lib/email';

const USER = '94592c0d-223a-4f08-9889-36b67ef783b7';
beforeAll(() => { process.env.UNSUBSCRIBE_SECRET = 'test-secret'; });

describe('unsubscribe links', () => {
  it('verify only for the same user and kind', () => {
    const u = new URL(unsubscribeUrl(USER, 'weekly'));
    const s = u.searchParams.get('s');
    expect(u.origin + u.pathname).toBe('https://www.recrutas.ai/api/email/unsubscribe');
    expect(verifyUnsubscribe(USER, 'weekly', s)).toBe(true);
    expect(verifyUnsubscribe(USER, 'updates', s)).toBe(false);
    expect(verifyUnsubscribe(USER.replace('9', '8'), 'weekly', s)).toBe(false);
    expect(verifyUnsubscribe(USER, 'weekly', 'forged')).toBe(false);
    expect(verifyUnsubscribe('not-a-uuid', 'weekly', s)).toBe(false);
  });

  it('adds one-click headers', () => {
    const h = unsubscribeHeaders(USER, 'updates');
    expect(h['List-Unsubscribe']).toMatch(/^<https:\/\/www\.recrutas\.ai\/api\/email\/unsubscribe\?u=.+&k=updates&s=.+>$/);
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('puts the link and the postal address in the footer', () => {
    process.env.EMAIL_POSTAL_ADDRESS = 'PO Box 123, Seattle, WA 98101';
    const empty = { appliedThisWeek: [], updates: [], waiting: 0, waitingPastFollowUp: 0, newApplyMatches: 1, topMatches: [], nextStep: null };
    const html = weeklySummaryEmail('Ada', empty, unsubscribeUrl(USER, 'weekly'));
    expect(html).toContain('>Unsubscribe</a>');
    expect(html).toContain('Recrutas · PO Box 123, Seattle, WA 98101');
    delete process.env.EMAIL_POSTAL_ADDRESS;
  });
});
