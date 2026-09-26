/**
 * /auth/confirm redeems the token from an auth email and routes on.
 *
 * Auth emails now link to our own domain instead of <project>.supabase.co —
 * Gmail flagged the Supabase-domain reset link as "This message might be
 * dangerous" (2026-09-26). If this page breaks, every reset and email-change
 * link breaks with it.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verifyOtp } = vi.hoisted(() => ({ verifyOtp: vi.fn() }));
vi.mock('@/lib/supabase-client', () => ({ supabase: { auth: { verifyOtp } } }));

import AuthConfirmPage from '../pages/auth-confirm';

function visit(search: string) {
  window.history.replaceState(null, '', '/auth/confirm' + search);
  return render(<AuthConfirmPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyOtp.mockResolvedValue({ error: null });
});

describe('AuthConfirmPage', () => {
  it('redeems a recovery link and continues to /reset-password', async () => {
    visit('?token_hash=abc123&type=recovery');
    await waitFor(() => expect(window.location.pathname).toBe('/reset-password'));
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc123', type: 'recovery' });
  });

  it('sends a confirmed email change back to the dashboard', async () => {
    visit('?token_hash=xyz&type=email_change');
    await waitFor(() => expect(window.location.pathname).toBe('/candidate-dashboard'));
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'xyz', type: 'email_change' });
  });

  it('strips the token from the address bar before verifying', async () => {
    let urlDuringVerify = '';
    verifyOtp.mockImplementation(async () => {
      urlDuringVerify = window.location.href;
      return { error: null };
    });
    visit('?token_hash=secret-token&type=recovery');
    await waitFor(() => expect(verifyOtp).toHaveBeenCalled());
    expect(urlDuringVerify).not.toContain('secret-token');
  });

  it('shows a way forward when the link is expired or reused', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'Email link is invalid or has expired' } });
    visit('?token_hash=old&type=recovery');
    expect(await screen.findByText(/expired or was already used/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new password reset link/ })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/auth/confirm');
  });

  it('rejects incomplete or unknown links without calling Supabase', async () => {
    visit('?type=recovery');
    expect(await screen.findByText(/expired or was already used/)).toBeInTheDocument();
    visit('?token_hash=abc&type=not_a_type');
    await waitFor(() => expect(screen.getAllByText(/expired or was already used/).length).toBeGreaterThan(0));
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});
