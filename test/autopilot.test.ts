import { describe, it, expect } from 'vitest';
import { decideAutopilot, BUSY_NOTICE, type AutopilotInput } from '../server/services/autopilot.service';
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

  it('emails every action with the reason', () => {
    const d = decideAutopilot({ ...calm, dbConnections: 45 }, S(), {}, { healthySince: {} }, t0);
    expect(d.alerts).toHaveLength(1);
    expect(d.alerts[0].subject).toMatch(/Autopilot: pauseNonEssentialCrons → true/);
    expect(d.alerts[0].body).toMatch(/45 DB connections/);
  });

  it('alerts (without changing anything) when embeddings fall behind', () => {
    const d = decideAutopilot({ ...calm, embeddingBacklog: 657 }, S(), {}, { healthySince: {} }, t0);
    expect(d.changes).toEqual([]);
    expect(d.alerts.map(a => a.key)).toEqual(['autopilot-embedding-backlog']);
    expect(decideAutopilot({ ...calm, embeddingBacklog: 40 }, S(), {}, { healthySince: {} }, t0).alerts).toEqual([]);
  });
});
