/**
 * Posting dates: store the employer's date, never a scraper's fallback "now".
 */
import { describe, it, expect } from 'vitest';
import { realPostedAt } from '../server/services/job-ingestion.service';

const now = new Date('2026-10-11T21:00:00Z');

describe('realPostedAt', () => {
  it('keeps a real employer date', () => {
    expect(realPostedAt('2026-10-06T14:00:00Z', now)?.toISOString()).toBe('2026-10-06T14:00:00.000Z');
    expect(realPostedAt(new Date('2026-09-01'), now)?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
  it('treats a fallback "now", a future date, garbage and implausibly old dates as unknown', () => {
    expect(realPostedAt(now.toISOString(), now)).toBeNull();
    expect(realPostedAt(new Date(now.getTime() - 5 * 60 * 1000), now)).toBeNull();     // 5 min ago: a default
    expect(realPostedAt('2026-10-13T00:00:00Z', now)).toBeNull();                       // future
    expect(realPostedAt('not a date', now)).toBeNull();
    expect(realPostedAt(null, now)).toBeNull();
    expect(realPostedAt('', now)).toBeNull();
    expect(realPostedAt('1999-01-01', now)).toBeNull();
  });
  it('accepts a date from earlier today that isn\'t a default', () => {
    expect(realPostedAt('2026-10-11T08:00:00Z', now)).not.toBeNull();
  });
});
