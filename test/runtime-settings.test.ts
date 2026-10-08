import { describe, it, expect, vi } from 'vitest';
vi.mock('../server/db', () => ({ db: {} }));
import { mergeSettings, parseSettingValue, isSettingKey, SETTING_DEFAULTS, setSetting } from '../server/services/runtime-settings.service';

describe('runtime settings', () => {
  it('uses defaults that match how the site behaves today', () => {
    expect(mergeSettings([])).toEqual(SETTING_DEFAULTS);
    expect(SETTING_DEFAULTS).toMatchObject({ feedCache: true, signupWaitlist: false, pauseNonEssentialCrons: false, noticeBanner: null, autopilot: true });
  });

  it('applies stored values and ignores unknown keys and invalid values', () => {
    const s = mergeSettings([
      { key: 'signupWaitlist', value: true },
      { key: 'feedCacheTtlMinutes', value: 'lots' },   // invalid, keep default
      { key: 'somethingElse', value: 1 },
    ]);
    expect(s.signupWaitlist).toBe(true);
    expect(s.feedCacheTtlMinutes).toBe(120);
    expect((s as any).somethingElse).toBeUndefined();
  });

  it('validates values with messages an admin can act on', () => {
    expect(parseSettingValue('feedCacheTtlMinutes', 1)).toMatchObject({ ok: false });
    expect(parseSettingValue('feedCacheTtlMinutes', 360)).toEqual({ ok: true, value: 360 });
    expect(parseSettingValue('noticeBanner', { text: 'Heavy traffic', level: 'warning' })).toMatchObject({ ok: true });
    expect(parseSettingValue('noticeBanner', { text: '', level: 'warning' })).toMatchObject({ ok: false });
    expect(parseSettingValue('noticeBanner', null)).toEqual({ ok: true, value: null });
  });

  it('knows its keys', () => {
    expect(isSettingKey('autopilot')).toBe(true);
    expect(isSettingKey('__proto__')).toBe(false);
  });

  it('requires a reason and refuses Autopilot on a pinned setting', async () => {
    const calls: string[] = [];
    const conn = (pinned: boolean) => ({ execute: async (q: any) => { calls.push('q'); return { rows: calls.length === 1 ? [{ value: false, pinned }] : [] }; } }) as any;
    expect(await setSetting('signupWaitlist', true, 'admin@x.com', '  ', {}, conn(false))).toEqual({ ok: false, error: 'A reason is required.' });
    calls.length = 0;
    expect(await setSetting('signupWaitlist', true, 'autopilot', 'overload', {}, conn(true))).toMatchObject({ ok: false });
    calls.length = 0;
    expect(await setSetting('signupWaitlist', true, 'admin@x.com', 'launch day', {}, conn(true))).toEqual({ ok: true });
  });
});
