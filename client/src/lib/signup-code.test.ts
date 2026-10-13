import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSignupCode, normalizeCode, rememberSignupCode } from './signup-code';

describe('signup code', () => {
  beforeEach(() => { localStorage.clear(); vi.useRealTimers(); });

  it('keeps the landing code for a later sign-up on another page', () => {
    rememberSignupCode('?code=reddit-a1b2');
    expect(getSignupCode('')).toBe('REDDIT-A1B2');
    expect(getSignupCode('?code=HN-X9')).toBe('HN-X9');  // a code in the URL wins
  });

  it('forgets it after 30 days', () => {
    rememberSignupCode('?code=X-1');
    vi.useFakeTimers({ now: Date.now() + 31 * 86_400_000 });
    expect(getSignupCode('')).toBe('');
  });

  it('ignores anything that is not a code', () => {
    rememberSignupCode('?code=%3Cscript%3E');
    expect(getSignupCode('')).toBe('');
    expect(normalizeCode('a'.repeat(41))).toBe('');
    expect(normalizeCode(' twitter-launch ')).toBe('TWITTER-LAUNCH');
  });
});
