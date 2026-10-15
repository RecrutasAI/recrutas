import { describe, it, expect } from 'vitest';
import { decideAutopilot, BUSY_NOTICE, SUPABASE_NOTICE, FAILOVER_NOTICE, isMissingTable, shouldReap, REAP_SQL, type AutopilotInput } from '../server/services/autopilot.service';
import { SETTING_DEFAULTS, type Settings } from '../server/services/runtime-settings.service';

const calm: AutopilotInput = { feedP95Ms: 400, feedSamples: 40, load1: 0.6, cpus: 2, memAvailableMb: 900, dbConnections: 7, diskPct: 53 };
const t0 = new Date('2026-10-08T12:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const S = (over: Partial<Settings> = {}): Settings => ({ ...SETTING_DEFAULTS, ...over });
const keys = (d: ReturnType<typeof decideAutopilot>) => Object.fromEntries(d.changes.map(c => [c.key, c.value]));

describe('decideAutopilot', () => {
  it('does nothing when everything is healthy', () => {
    const d = decideAutopilot(calm, S(), {}, { healthySince: {} }, t0);
    expect(d.changes).toEqual([]);
    expect(d.alerts).toEqual([]);
  });

  it('a slow feed lengthens the cache lifetime (and turns the cache on if an admin had it off)', () => {
    const slow = { ...calm, feedP95Ms: 3500 };
    expect(keys(decideAutopilot(slow, S(), {}, { healthySince: {} }, t0))).toEqual({ feedCacheTtlMinutes: 360 });
    expect(keys(decideAutopilot(slow, S({ feedCache: false }), {}, { healthySince: {} }, t0))).toEqual({ feedCache: true, feedCacheTtlMinutes: 360 });
  });

  it('ignores a slow p95 measured on fewer than 5 requests', () => {
    expect(decideAutopilot({ ...calm, feedP95Ms: 6600, feedSamples: 3 }, S(), {}, { healthySince: {} }, t0).changes).toEqual([]);
  });

  it('high CPU load pauses background jobs and protects the feed', () => {
    expect(keys(decideAutopilot({ ...calm, load1: 3.4 }, S(), {}, { healthySince: {} }, t0)))
      .toEqual({ feedCacheTtlMinutes: 360, pauseNonEssentialCrons: true });
  });

  it('low RAM pauses background jobs', () => {
    expect(keys(decideAutopilot({ ...calm, memAvailableMb: 150 }, S(), {}, { healthySince: {} }, t0))).toEqual({ pauseNonEssentialCrons: true });
  });

  it('too many DB connections pause jobs and show the busy banner', () => {
    expect(keys(decideAutopilot({ ...calm, dbConnections: 45 }, S(), {}, { healthySince: {} }, t0)))
      .toEqual({ pauseNonEssentialCrons: true, noticeBanner: BUSY_NOTICE });
  });

  it('waits 15 healthy minutes before undoing its own changes', () => {
    const mineAll = { pauseNonEssentialCrons: 'autopilot', noticeBanner: 'autopilot', feedCacheTtlMinutes: 'autopilot' };
    const under = S({ pauseNonEssentialCrons: true, noticeBanner: BUSY_NOTICE, feedCacheTtlMinutes: 360 });
    let state = decideAutopilot(calm, under, mineAll, { healthySince: {} }, at(0)).state;
    expect(decideAutopilot(calm, under, mineAll, state, at(10)).changes).toEqual([]);
    state = decideAutopilot(calm, under, mineAll, state, at(10)).state;
    expect(keys(decideAutopilot(calm, under, mineAll, state, at(15))))
      .toEqual({ feedCacheTtlMinutes: 120, pauseNonEssentialCrons: false, noticeBanner: null });
  });

  it('a blip of pressure restarts the 15-minute clock', () => {
    const mine = { pauseNonEssentialCrons: 'autopilot' };
    const under = S({ pauseNonEssentialCrons: true });
    let state = decideAutopilot(calm, under, mine, { healthySince: {} }, at(0)).state;
    state = decideAutopilot({ ...calm, load1: 3.4 }, under, mine, state, at(10)).state;
    state = decideAutopilot(calm, under, mine, state, at(11)).state;
    expect(decideAutopilot(calm, under, mine, state, at(20)).changes).toEqual([]);
    expect(keys(decideAutopilot(calm, under, mine, state, at(26)))).toEqual({ pauseNonEssentialCrons: false });
  });

  it('turns on the sign-up waitlist only after people have seen a slow feed for 15 min with the cache stretched', () => {
    const slow = { ...calm, feedP95Ms: 3500 };
    const stretched = S({ feedCacheTtlMinutes: 360 });
    const d0 = decideAutopilot(slow, stretched, {}, { healthySince: {} }, t0);
    expect(keys(d0)).toEqual({});
    const d1 = decideAutopilot(slow, stretched, {}, d0.state, at(14));
    expect(keys(d1)).toEqual({});
    const d2 = decideAutopilot(slow, stretched, {}, d1.state, at(15));
    expect(keys(d2)).toEqual({ signupWaitlist: true });
    // Cache not stretched yet: that step comes first.
    expect(keys(decideAutopilot(slow, S(), {}, d1.state, at(15)))).toEqual({ feedCacheTtlMinutes: 360 });
  });

  it('never closes sign-ups for CPU load alone (background work, nobody waiting)', () => {
    const busy = { ...calm, load1: 4 };
    let state = { healthySince: {} } as any;
    for (const m of [0, 10, 20, 40]) {
      const d = decideAutopilot(busy, S({ feedCacheTtlMinutes: 360 }), {}, state, at(m));
      expect(keys(d).signupWaitlist).toBeUndefined();
      state = d.state;
    }
  });

  it('reopens sign-ups after 15 fast minutes, but only if Autopilot closed them', () => {
    const on = S({ feedCacheTtlMinutes: 360, signupWaitlist: true });
    const d0 = decideAutopilot(calm, on, { signupWaitlist: 'autopilot' }, { healthySince: {} }, t0);
    expect(keys(d0).signupWaitlist).toBeUndefined();
    expect(keys(decideAutopilot(calm, on, { signupWaitlist: 'autopilot' }, d0.state, at(15))).signupWaitlist).toBe(false);
    expect(keys(decideAutopilot(calm, on, { signupWaitlist: 'admin@example.com' }, d0.state, at(15))).signupWaitlist).toBeUndefined();
  });

  it('posts the sign-in banner after Supabase is down 2 min, and takes it down after 5 min up', () => {
    const down = { ...calm, supabaseUp: false };
    const d0 = decideAutopilot(down, S(), {}, { healthySince: {} }, t0);
    expect(keys(d0)).toEqual({});
    const d1 = decideAutopilot(down, S(), {}, d0.state, at(2));
    expect(keys(d1)).toEqual({ noticeBanner: SUPABASE_NOTICE });
    expect(d1.alerts.map(a => a.key)).toContain('autopilot-supabase-down');
    const on = S({ noticeBanner: SUPABASE_NOTICE });
    const u0 = decideAutopilot({ ...calm, supabaseUp: true }, on, { noticeBanner: 'autopilot' }, d1.state, at(3));
    expect(keys(u0)).toEqual({});
    expect(keys(decideAutopilot({ ...calm, supabaseUp: true }, on, { noticeBanner: 'autopilot' }, u0.state, at(8)))).toEqual({ noticeBanner: null });
  });

  it('keeps an admin banner, and each rule only clears its own banner', () => {
    const admin = { text: 'Maintenance tonight', level: 'info' as const };
    const d = decideAutopilot({ ...calm, supabaseUp: false }, S({ noticeBanner: admin }), { noticeBanner: 'admin@example.com' }, { healthySince: {}, supabaseDownSince: t0.toISOString() }, at(5));
    expect(keys(d).noticeBanner).toBeUndefined();
    // Connections recovering must not take down the Supabase banner.
    const s = decideAutopilot({ ...calm, supabaseUp: false }, S({ noticeBanner: SUPABASE_NOTICE }), { noticeBanner: 'autopilot' },
      { healthySince: { conns: t0.toISOString() }, supabaseDownSince: t0.toISOString() }, at(20));
    expect(keys(s).noticeBanner).toBeUndefined();
  });

  it('moves sign-in to the backup after Supabase is down 5 min, only when the backup is ready', () => {
    const down = { ...calm, supabaseUp: false, backupAuthReady: true };
    const since = { healthySince: {}, supabaseDownSince: t0.toISOString() };
    expect(keys(decideAutopilot(down, S(), {}, since, at(4))).authProvider).toBeUndefined();
    expect(keys(decideAutopilot(down, S(), {}, since, at(5)))).toEqual({ authProvider: 'recrutas', noticeBanner: FAILOVER_NOTICE });
    // Backup not ready: no switch, just the "sign-in unavailable" banner.
    expect(keys(decideAutopilot({ ...down, backupAuthReady: false }, S(), {}, since, at(5)))).toEqual({ noticeBanner: SUPABASE_NOTICE });
    // Replaces its own Supabase banner, never an admin's.
    expect(keys(decideAutopilot(down, S({ noticeBanner: SUPABASE_NOTICE }), { noticeBanner: 'autopilot' }, since, at(5))).noticeBanner).toEqual(FAILOVER_NOTICE);
    const admin = { text: 'Maintenance tonight', level: 'info' as const };
    expect(keys(decideAutopilot(down, S({ noticeBanner: admin }), { noticeBanner: 'admin@example.com' }, since, at(5)))).toEqual({ authProvider: 'recrutas' });
  });

  it('never switches sign-in back by itself, but emails when Supabase is back', () => {
    const on = S({ authProvider: 'recrutas', noticeBanner: FAILOVER_NOTICE });
    const d = decideAutopilot({ ...calm, supabaseUp: true, backupAuthReady: true }, on, { authProvider: 'autopilot', noticeBanner: 'autopilot' },
      { healthySince: {}, supabaseUpSince: t0.toISOString() }, at(10));
    expect(keys(d).authProvider).toBeUndefined();
    expect(keys(d).noticeBanner).toBeUndefined();
    expect(d.alerts.map(a => a.key)).toContain('autopilot-supabase-back');
  });

  it('respects a pinned or admin-chosen sign-in server (setSetting refuses pinned; decide never reverts)', () => {
    const d = decideAutopilot({ ...calm, supabaseUp: false, backupAuthReady: true }, S({ authProvider: 'recrutas' }), { authProvider: 'admin@example.com' },
      { healthySince: {}, supabaseDownSince: t0.toISOString() }, at(10));
    expect(keys(d).authProvider).toBeUndefined();
    expect(d.alerts.map(a => a.key)).not.toContain('autopilot-supabase-down');
  });

  it('never undoes a switch an admin set', () => {
    const under = S({ pauseNonEssentialCrons: true, noticeBanner: { text: 'Maintenance tonight', level: 'info' } });
    const byAdmin = { pauseNonEssentialCrons: 'founder@recrutas.ai', noticeBanner: 'founder@recrutas.ai' };
    let state = decideAutopilot(calm, under, byAdmin, { healthySince: {} }, at(0)).state;
    state = decideAutopilot(calm, under, byAdmin, state, at(5)).state;
    expect(decideAutopilot(calm, under, byAdmin, state, at(30)).changes).toEqual([]);
  });

  it('does not replace an admin banner with the busy banner', () => {
    const d = decideAutopilot({ ...calm, dbConnections: 45 }, S({ noticeBanner: { text: 'Maintenance tonight', level: 'info' } }), {}, { healthySince: {} }, t0);
    expect(keys(d)).toEqual({ pauseNonEssentialCrons: true });
  });

  it('changes nothing when the Autopilot switch is off, but still alerts on disk', () => {
    const d = decideAutopilot({ ...calm, load1: 4, dbConnections: 50, diskPct: 91 }, S({ autopilot: false }), {}, { healthySince: {} }, t0);
    expect(d.changes).toEqual([]);
    expect(d.alerts.map(a => a.key)).toEqual(['autopilot-disk']);
  });

  it('internal protection acts without an email; a switch people can see is emailed with the reason', () => {
    const d = decideAutopilot({ ...calm, dbConnections: 45 }, S(), {}, { healthySince: {} }, t0);
    expect(d.changes.map(c => c.key)).toContain('pauseNonEssentialCrons');
    expect(d.changes.map(c => c.key)).toContain('noticeBanner');
    expect(d.alerts).toHaveLength(1);
    expect(d.alerts[0].subject).toMatch(/Autopilot: noticeBanner/);
    expect(d.alerts[0].subject).not.toMatch(/pauseNonEssentialCrons/);
    expect(d.alerts[0].body).toMatch(/45 DB connections/);
  });

  it('a short load spike (the morning scrape) sends no email; an hour of pressure does', () => {
    const busy = { ...calm, load1: 3.5 };
    const first = decideAutopilot(busy, S(), {}, { healthySince: {} }, t0);
    expect(first.changes.map(c => c.key)).toContain('pauseNonEssentialCrons');
    expect(first.alerts).toEqual([]);
    const later = decideAutopilot(busy, S(), {}, first.state, new Date(t0.getTime() + 61 * 60_000));
    expect(later.alerts.map(a => a.key)).toContain('autopilot-pressure-long');
  });

  it('alerts (without changing anything) when batches stop: nothing embedded for over 14 h while jobs wait', () => {
    const d = decideAutopilot({ ...calm, embeddingBacklog: 657, embeddingSinceLastMin: 15 * 60, embeddingSkipped: 0 }, S(), {}, { healthySince: {} }, t0);
    expect(d.changes).toEqual([]);
    expect(d.alerts.map(a => a.key)).toEqual(['autopilot-embedding-backlog']);
    expect(d.alerts[0].subject).toMatch(/no new jobs matched for 15\.0 h/);
    // 2,000 waiting 5 hours into a 6-hour cycle is normal.
    expect(decideAutopilot({ ...calm, embeddingBacklog: 2000, embeddingSinceLastMin: 5 * 60, embeddingSkipped: 0 }, S(), {}, { healthySince: {} }, t0).alerts).toEqual([]);
  });

  it('alerts when a batch ran but left waiting jobs behind', () => {
    const d = decideAutopilot({ ...calm, embeddingBacklog: 900, embeddingSinceLastMin: 60, embeddingSkipped: 12 }, S(), {}, { healthySince: {} }, t0);
    expect(d.alerts[0].subject).toMatch(/12 jobs left unmatched by the last batch/);
  });

  it('2026-10-15: jobs still queued in a batch that is running right now are not "left behind"', () => {
    // 13:02:05: the 13:00 batch had just embedded its newest jobs and was finishing the older 166.
    expect(decideAutopilot({ ...calm, embeddingBacklog: 167, embeddingSinceLastMin: 0.1, embeddingSkipped: 166 }, S(), {}, { healthySince: {} }, t0).alerts).toEqual([]);
  });

  it('2026-10-14: a closed job reopened after the last batch (old created_at) is not an alert', () => {
    // 979 waiting, the batch ran 3 h ago, and none were waiting before it: one of them was
    // created 20 h earlier but reopened a minute ago. The old rule alerted "20 hours".
    expect(decideAutopilot({ ...calm, embeddingBacklog: 979, embeddingSinceLastMin: 3 * 60, embeddingSkipped: 0 }, S(), {}, { healthySince: {} }, t0).alerts).toEqual([]);
  });
});
