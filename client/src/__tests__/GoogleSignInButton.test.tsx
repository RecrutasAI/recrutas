/**
 * Google sign-in runs in Google's own popup (GIS) when VITE_GOOGLE_CLIENT_ID is
 * set, so Google's screen names recrutas.ai instead of fgdx….supabase.co. The
 * redirect flow stays as the fallback for when the client id is missing or
 * Google's script can't load.
 */
import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';

const { signInWithOAuth, signInWithIdToken, setLocation } = vi.hoisted(() => ({
  signInWithOAuth: vi.fn(),
  signInWithIdToken: vi.fn(),
  setLocation: vi.fn(),
}));
vi.mock('@/lib/supabase-client', () => ({ supabase: { auth: { signInWithOAuth, signInWithIdToken } } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('wouter', () => ({ useLocation: () => ['/auth', setLocation] }));

import { GoogleSignInButton } from '../components/google-sign-in-button';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

async function sha256Hex(text: string): Promise<string> {
  const d = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

beforeEach(() => {
  vi.clearAllMocks();
  delete (window as any).google;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('GoogleSignInButton', () => {
  it('uses the redirect flow when no client id is configured', async () => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', '');
    signInWithOAuth.mockResolvedValue({ error: null });
    render(<GoogleSignInButton />);
    await act(async () => screen.getByRole('button', { name: 'Continue with Google' }).click());
    expect(signInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google' }));
  });

  it("renders Google's button and signs in with the ID token and matching nonce", async () => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', CLIENT_ID);
    const initialize = vi.fn();
    const renderButton = vi.fn();
    (window as any).google = { accounts: { id: { initialize, renderButton } } };
    signInWithIdToken.mockResolvedValue({ error: null });

    render(<GoogleSignInButton label="Sign up with Google" />);
    await waitFor(() => expect(renderButton).toHaveBeenCalled());

    const config = initialize.mock.calls[0][0];
    expect(config.client_id).toBe(CLIENT_ID);
    expect(renderButton.mock.calls[0][1].text).toBe('signup_with');

    await act(async () => config.callback({ credential: 'id-token' }));
    const { nonce: rawNonce, token } = signInWithIdToken.mock.calls[0][0];
    expect(token).toBe('id-token');
    // Google is given the hash, Supabase the raw value it hashes to.
    expect(config.nonce).toBe(await sha256Hex(rawNonce));
    expect(setLocation).toHaveBeenCalledWith('/auth');
  });

  it("falls back to the redirect button when Google's script never loads", async () => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', CLIENT_ID);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<GoogleSignInButton />);
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
  });
});
