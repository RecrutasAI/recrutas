/**
 * "Live · checked" must mean the job was on the employer's board within the
 * last scrape cycle or so. Measured 2026-09-26: a 14-day window badged 24,160
 * jobs that hadn't been seen in over 48h — including jobs already taken down.
 */
import { describe, it, expect } from 'vitest';
import { isRecentlyVerifiedLive, hoursSinceLivenessCheck, formatCheckedAgo, LIVE_BADGE_MAX_AGE_HOURS } from '../shared/liveness';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const live = (h: number | null, extra: object = {}) => ({
  livenessStatus: 'active', trustScore: 95, lastLivenessCheck: h === null ? null : hoursAgo(h), ...extra,
});

describe('isRecentlyVerifiedLive', () => {
  it('badges a job seen within the scrape cycle', () => {
    expect(isRecentlyVerifiedLive(live(3), NOW)).toBe(true);
    expect(isRecentlyVerifiedLive(live(LIVE_BADGE_MAX_AGE_HOURS), NOW)).toBe(true);
  });

  it('drops the badge once a job has been missing past the window (the "checked 5d ago" bug)', () => {
    expect(isRecentlyVerifiedLive(live(LIVE_BADGE_MAX_AGE_HOURS + 1), NOW)).toBe(false);
    expect(isRecentlyVerifiedLive(live(5 * 24), NOW)).toBe(false);
  });

  it('never badges without a real check, low trust, or a non-active status', () => {
    expect(isRecentlyVerifiedLive(live(null), NOW)).toBe(false);
    expect(isRecentlyVerifiedLive(live(1, { trustScore: 50 }), NOW)).toBe(false);
    expect(isRecentlyVerifiedLive(live(1, { livenessStatus: 'stale' }), NOW)).toBe(false);
    expect(isRecentlyVerifiedLive(live(1, { lastLivenessCheck: 'not a date' }), NOW)).toBe(false);
  });

  it('accepts Date objects as returned by the DB driver', () => {
    expect(isRecentlyVerifiedLive({ ...live(null), lastLivenessCheck: new Date(NOW - 3_600_000) }, NOW)).toBe(true);
    expect(hoursSinceLivenessCheck({ lastLivenessCheck: new Date(NOW - 7_200_000) }, NOW)).toBeCloseTo(2);
  });
});

describe('formatCheckedAgo (badge label)', () => {
  it('labels recent checks in hours', () => {
    expect(formatCheckedAgo(hoursAgo(0.2), NOW)).toBe('just now');
    expect(formatCheckedAgo(hoursAgo(5), NOW)).toBe('5h ago');
    expect(formatCheckedAgo(hoursAgo(30), NOW)).toBe('30h ago');
  });

  it('shows nothing past the window instead of "Nd ago"', () => {
    expect(formatCheckedAgo(hoursAgo(5 * 24), NOW)).toBeNull();
    expect(formatCheckedAgo(null, NOW)).toBeNull();
  });
});
