/**
 * Posting dates: store the employer's date, never a scraper's fallback "now".
 */
import { describe, it, expect } from 'vitest';
import { realPostedAt } from '../server/services/job-ingestion.service';

const now = new Date('2026-10-11T21:00:00Z');

describe('realPostedAt', () => {
  it('keeps a real employer date', () => {
    expect(realPostedAt('2026-10-06T14:00:00Z', now)?.toISOString()).toBe('2026-10-06T14:00:00.000Z');
  });
  it('keeps a day with no time on that day in US time zones (noon UTC)', () => {
    expect(realPostedAt(new Date('2026-09-01'), now)?.toISOString()).toBe('2026-09-01T12:00:00.000Z');
    expect(realPostedAt('2026-10-08T00:00:00+00:00', now)?.toISOString()).toBe('2026-10-08T12:00:00.000Z');
    const shown = realPostedAt('2026-10-08T00:00:00+00:00', now)!;
    for (const tz of ['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu']) {
      expect(shown.toLocaleDateString('en-US', { timeZone: tz })).toBe('10/8/2026');
    }
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

import { parseSourceDate, workdayPostedOn } from '../server/lib/posted-date';
import { atsDate } from '../server/lib/adzuna-link-resolver';

describe('source posting dates', () => {
  it('reads each ATS format', () => {
    expect(parseSourceDate('2026-09-03T13:30:34-04:00')?.toISOString()).toBe('2026-09-03T17:30:34.000Z');   // Greenhouse first_published
    expect(parseSourceDate(1786469891368)?.toISOString()).toBe(new Date(1786469891368).toISOString());     // Lever createdAt (ms)
    expect(parseSourceDate('2026-10-05 13:25:03 UTC')?.toISOString()).toBe('2026-10-05T13:25:03.000Z');   // Recruitee
    expect(parseSourceDate('2026-05-29')?.toISOString()).toBe('2026-05-29T00:00:00.000Z');                 // Workable
    expect(atsDate('2026-04-07T17:12:35.753+00:00')).toBe('2026-04-07T17:12:35.753Z');                     // Ashby
    expect(parseSourceDate('')).toBeNull();
    expect(parseSourceDate(undefined)).toBeNull();
    expect(parseSourceDate('Posted 3 Days Ago')).toBeNull();
  });

  it('turns Workday\'s relative "Posted N Days Ago" into the day, and "30+" into nothing', () => {
    const now = new Date('2026-10-11T21:00:00Z');
    expect(workdayPostedOn('Posted Today', now)?.toISOString().slice(0, 10)).toBe('2026-10-11');
    expect(workdayPostedOn('Posted Yesterday', now)?.toISOString().slice(0, 10)).toBe('2026-10-10');
    expect(workdayPostedOn('Posted 3 Days Ago', now)?.toISOString().slice(0, 10)).toBe('2026-10-08');
    expect(workdayPostedOn('Posted 30+ Days Ago', now)).toBeNull();
    expect(workdayPostedOn(undefined, now)).toBeNull();
  });
});

import { ashbyLocation } from '../server/lib/adzuna-link-resolver';
describe('ashbyLocation', () => {
  it('reads every place with its country when the text lacks it', () => {
    expect(ashbyLocation({ location: 'India | Pune', address: { postalAddress: { addressCountry: 'India' } } })).toBe('India | Pune');
    expect(ashbyLocation({ location: 'Pune', address: { postalAddress: { addressCountry: 'India' } } })).toBe('Pune, India');
    expect(ashbyLocation({ location: 'New York, NY (HQ)', address: { postalAddress: { addressCountry: 'USA' } },
      secondaryLocations: [{ location: 'Remote (Canada)', address: { postalAddress: { addressCountry: 'Canada' } } }, { location: 'Miami, FL' }] }))
      .toBe('New York, NY (HQ); Remote (Canada); Miami, FL');
    expect(ashbyLocation({})).toBeUndefined();
  });
});

import { workplaceOf } from '../server/lib/adzuna-link-resolver';
describe('workplaceOf', () => {
  it('maps each ATS spelling of the work arrangement', () => {
    expect(workplaceOf('OnSite')).toBe('onsite');
    expect(workplaceOf('on-site')).toBe('onsite');
    expect(workplaceOf('Hybrid')).toBe('hybrid');
    expect(workplaceOf('remote')).toBe('remote');
    expect(workplaceOf('unspecified')).toBeUndefined();
    expect(workplaceOf(undefined)).toBeUndefined();
  });
});
