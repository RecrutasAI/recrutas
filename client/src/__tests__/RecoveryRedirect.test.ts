/**
 * A password-recovery link must end on /reset-password, wherever it lands.
 *
 * Found on prod 2026-09-26: the reset email linked to https://recrutas.ai (the
 * Supabase Site URL fallback, because /reset-password wasn't on the redirect
 * allow-list). The home page signed the user in and routed them to
 * /role-selection — the new-password form never appeared.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ auth: {} })) }));

async function loadClientAt(url: string): Promise<string> {
  window.history.replaceState(null, '', url);
  vi.resetModules();
  await import('../lib/supabase-client');
  return window.location.pathname + window.location.hash;
}

describe('supabase-client recovery redirect', () => {
  beforeEach(() => window.history.replaceState(null, '', '/'));

  it('moves recovery tokens from the home page to /reset-password', async () => {
    const hash = '#access_token=abc&expires_in=3600&refresh_token=def&token_type=bearer&type=recovery';
    expect(await loadClientAt('/' + hash)).toBe('/reset-password' + hash);
  });

  it('works when type=recovery is the first hash parameter', async () => {
    expect(await loadClientAt('/role-selection#type=recovery&access_token=abc'))
      .toBe('/reset-password#type=recovery&access_token=abc');
  });

  it('leaves other auth redirects (sign-in, email change) where they are', async () => {
    expect(await loadClientAt('/auth#access_token=abc&type=signup')).toBe('/auth#access_token=abc&type=signup');
    expect(await loadClientAt('/candidate-dashboard#access_token=abc&type=email_change'))
      .toBe('/candidate-dashboard#access_token=abc&type=email_change');
  });

  it('does not match look-alike values', async () => {
    expect(await loadClientAt('/#type=recoveryx')).toBe('/#type=recoveryx');
  });
});
