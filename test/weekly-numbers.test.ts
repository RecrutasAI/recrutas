import { describe, expect, it } from 'vitest';
import { weeklyMarkdown, type WeeklyNumbers } from '../server/services/weekly-numbers.service';
import { orderedSteps, type PersonTimes } from '../server/services/admin-insights.service';

const signedUp = (n: number, resume: number, feed: number, autofill: number): PersonTimes[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (m: number) => new Date(Date.UTC(2026, 9, 12) + m * 60_000);
    return { signup: t(0), resume: i < resume ? t(1) : null, feeds: i < feed ? [t(2)] : [], autofills: i < autofill ? [t(3)] : [] };
  });

const base: WeeklyNumbers = {
  generatedAt: '2026-10-19T11:30:00.000Z',
  weekStart: '2026-10-12',
  signups: { thisWeek: 4, priorWeek: 1, total: 25 },
  resumes: { thisWeekSignups: 4, ofThem: 3, last30Signups: 9, last30OfThem: 5 },
  applications: { thisWeek: 2, priorWeek: 0 },
  activation: {
    last7: orderedSteps(signedUp(4, 3, 3, 1)),
    last30: orderedSteps(signedUp(9, 5, 5, 1)),
  },
  channels: [
    { channel: 'reddit', signups: 3, activated: 1, codes: ['REDDIT-A1'] },
    { channel: 'none', signups: 6, activated: 0, codes: [] },
  ],
  supply: { catalogJobs: 1069522, catalogAt: '2026-10-19T03:02:00.000Z', directActive: 120000 },
};

describe('weeklyMarkdown', () => {
  it('reports activation, resume rate and channels', () => {
    const md = weeklyMarkdown(base);
    expect(md).toContain('This week: **4** (the week before: 1)');
    expect(md).toContain('**3 of 4** (75%)');
    expect(md).toContain('Last 7 days: **1 activated**');
    expect(md).toContain('| reddit | 3 | 1 | REDDIT-A1 |');
    expect(md).toContain('**1,069,522**');
  });

  it('says "not available" when PostHog did not answer, never 0', () => {
    const md = weeklyMarkdown({ ...base, activation: { last7: null, last30: null }, channels: [{ channel: 'hn', signups: 2, activated: null, codes: [] }] });
    expect(md).toContain('Last 7 days: not available');
    expect(md).toContain('| hn | 2 | not available | — |');
    expect(md).not.toMatch(/Last 7 days: \*\*0/);
  });

  it('handles a week with no sign-ups', () => {
    const md = weeklyMarkdown({ ...base, resumes: { thisWeekSignups: 0, ofThem: 0, last30Signups: 0, last30OfThem: 0 }, channels: [] });
    expect(md).toContain('**0 of 0** (—)');
    expect(md).toContain('No sign-ups in the last 30 days.');
  });
});
