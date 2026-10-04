import { describe, it, expect, vi } from 'vitest';
vi.mock('../server/db', () => ({ db: {} }));
vi.mock('../server/storage', () => ({ storage: {} }));
import { hasNews, summarySubject, type WeeklySummary } from '../server/services/weekly-summary.service';
import { weeklySummaryEmail } from '../server/lib/email';

const empty: WeeklySummary = { appliedThisWeek: [], updates: [], waiting: 0, waitingPastFollowUp: 0, newApplyMatches: 0, topMatches: [], nextStep: null };

describe('weekly summary', () => {
  it('stays quiet when the week has no news', () => {
    expect(hasNews(empty)).toBe(false);
    expect(hasNews({ ...empty, waiting: 3 })).toBe(false);
    expect(hasNews({ ...empty, newApplyMatches: 2 })).toBe(true);
  });

  it('summarizes the week in the subject', () => {
    expect(summarySubject({ ...empty, appliedThisWeek: [{ title: 'A', company: 'B' }], updates: [{ kind: 'taken_down', title: 'A', company: 'B' }, { kind: 'replied', title: 'C', company: 'D' }], newApplyMatches: 14 }))
      .toBe('Your week: 1 application, 2 updates, 14 new jobs you qualify for');
  });

  it('renders each section and escapes job data', () => {
    const html = weeklySummaryEmail('Abas K', {
      ...empty,
      appliedThisWeek: [{ title: 'Support <Engineer>', company: 'Acme' }],
      updates: [{ kind: 'reposted', title: 'IT Support', company: 'Rocket Lab' }],
      waiting: 3, waitingPastFollowUp: 1, newApplyMatches: 2,
      topMatches: [{ title: 'Help Desk', company: 'PubMatic', location: 'Remote' }],
      nextStep: 'Apply sooner.',
    });
    expect(html).toContain('Hi Abas,');
    expect(html).toContain('Support &lt;Engineer&gt; · Acme');
    expect(html).toContain('IT Support at Rocket Lab was taken down and posted again');
    expect(html).toContain('3 applications with the job still posted, 1 of them past two weeks');
    expect(html).toContain('2 new jobs you qualify for');
    expect(html).toContain('Next step:</strong> Apply sooner.');
  });
});
