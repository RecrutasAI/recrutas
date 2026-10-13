import { afterEach, describe, expect, it } from 'vitest';
import { underDailyCap } from '../server/lib/email-budget';

const conn = (n: number | Error) => ({ execute: (async () => { if (n instanceof Error) {throw n;} return { rows: [{ n }] }; }) as any });

describe('underDailyCap', () => {
  afterEach(() => { delete process.env.WELCOME_EMAIL_DAILY_MAX; });

  it('sends up to the cap (today\'s count includes the row just saved)', async () => {
    expect(await underDailyCap('welcome', conn(1))).toBe(true);
    expect(await underDailyCap('welcome', conn(15))).toBe(true);
    expect(await underDailyCap('welcome', conn(16))).toBe(false);
    expect(await underDailyCap('waitlist', conn(16))).toBe(false);
  });

  it('cap is set by env', async () => {
    process.env.WELCOME_EMAIL_DAILY_MAX = '40';
    expect(await underDailyCap('welcome', conn(30))).toBe(true);
  });

  it('skips the email when the count fails', async () => {
    expect(await underDailyCap('welcome', conn(new Error('db down')))).toBe(false);
  });
});
