import { describe, it, expect, vi } from 'vitest';
vi.mock('../server/db', () => ({ db: {} }));
import {
  feedCacheKey, isFeedCacheFresh, stripForCache, hydrateCachedFeed, feedCacheEnabled, feedCacheTtlMs,
} from '../server/services/feed-cache.service';

describe('feed cache key', () => {
  it('treats the same filters the same way regardless of case, spacing and empty values', () => {
    expect(feedCacheKey({ jobTitle: '  Software   Engineer ', location: 'Austin' }))
      .toBe(feedCacheKey({ jobTitle: 'software engineer', location: 'austin', workType: '' }));
  });
  it('keeps different filters apart', () => {
    expect(feedCacheKey({ postedWithinDays: 7 })).not.toBe(feedCacheKey({ postedWithinDays: 1 }));
    expect(feedCacheKey(undefined)).not.toBe(feedCacheKey({ workType: 'remote' }));
  });
});

describe('feed cache freshness', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const ttl = 120 * 60_000;
  it('is fresh inside the TTL when the profile has not changed since', () => {
    expect(isFeedCacheFresh(new Date('2026-10-08T11:00:00Z'), new Date('2026-10-08T09:00:00Z'), now, ttl)).toBe(true);
  });
  it('goes stale after the TTL', () => {
    expect(isFeedCacheFresh(new Date('2026-10-08T09:30:00Z'), null, now, ttl)).toBe(false);
  });
  it('goes stale as soon as the profile or embedding changes', () => {
    expect(isFeedCacheFresh(new Date('2026-10-08T11:00:00Z'), new Date('2026-10-08T11:30:00Z'), now, ttl)).toBe(false);
  });
});

describe('what the cache stores and serves', () => {
  it('stores ranked jobs without their heavy text', () => {
    const [job] = stripForCache([{ id: 1, title: 'SWE', matchScore: 80, description: 'long', requirements: ['a'] }]);
    expect(job).toEqual({ id: 1, title: 'SWE', matchScore: 80 });
  });

  it('drops hidden, applied and no-longer-active jobs, keeps rank order, and restores text', () => {
    const cached = [{ id: 3, matchScore: 90 }, { id: 1, matchScore: 85 }, { id: 2, matchScore: 80 }, { id: 4, matchScore: 70 }];
    const live = new Map([
      [1, { description: 'one', requirements: ['r1'], status: 'active' }],
      [2, { description: 'two', requirements: null, status: 'closed' }],   // taken down since
      [3, { description: 'three', requirements: [], status: 'active' }],  // hidden by the candidate
      [4, { description: null, requirements: [], status: 'active' }],
    ]);
    const out = hydrateCachedFeed(cached, live, new Set([3]));
    expect(out.map(j => j.id)).toEqual([1, 4]);
    expect(out[0]).toMatchObject({ description: 'one', requirements: ['r1'] });
    expect(out[1]).toMatchObject({ description: null, requirements: [] });
  });

  it('drops jobs that no longer exist at all', () => {
    expect(hydrateCachedFeed([{ id: 9 }], new Map(), new Set())).toEqual([]);
  });
});

describe('feed cache switches', () => {
  it('is on by default and can be turned off', () => {
    expect(feedCacheEnabled({} as any)).toBe(true);
    expect(feedCacheEnabled({ FEED_CACHE: 'off' } as any)).toBe(false);
  });
  it('defaults to a 2-hour TTL and accepts an override', () => {
    expect(feedCacheTtlMs({} as any)).toBe(120 * 60_000);
    expect(feedCacheTtlMs({ FEED_CACHE_TTL_MINUTES: '30' } as any)).toBe(30 * 60_000);
    expect(feedCacheTtlMs({ FEED_CACHE_TTL_MINUTES: 'junk' } as any)).toBe(120 * 60_000);
  });
});
