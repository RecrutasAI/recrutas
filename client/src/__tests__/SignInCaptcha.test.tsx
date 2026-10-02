/**
 * With CAPTCHA enabled in Supabase, a password sign-in without a token is
 * rejected. Simulates a configured site key: the button is clickable before
 * Cloudflare's check finishes, a submit waits for the token and sends it, and
 * the widget resets after each try (tokens are single-use).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { forwardRef, useImperativeHandle } from 'react';

const { signInWithPassword, resetSpy, widget } = vi.hoisted(() => {
  // Mirrors the real handle: getToken resolves now, or on the next check result.
  const widget = {
    token: null as string | null,
    waiters: [] as ((t: string | null) => void)[],
    finish(t: string | null) {
      widget.token = t;
      widget.waiters.splice(0).forEach((w) => w(t));
    },
  };
  return { signInWithPassword: vi.fn(), resetSpy: vi.fn(), widget };
});

vi.mock('@/components/turnstile', () => ({
  captchaEnabled: true,
  Turnstile: forwardRef(function FakeTurnstile(_props, ref) {
    useImperativeHandle(ref, () => ({
      getToken: () => widget.token
        ? Promise.resolve(widget.token)
        : new Promise<string | null>((r) => widget.waiters.push(r)),
      reset: () => { resetSpy(); widget.token = null; },
    }));
    return <div data-testid="turnstile" />;
  }),
}));
vi.mock('@supabase/auth-helpers-react', () => ({
  useSupabaseClient: () => ({ auth: { signInWithPassword } }),
  useSession: () => null,
}));
vi.mock('@/components/google-sign-in-button', () => ({ GoogleSignInButton: () => null, OrDivider: () => null }));
vi.mock('@/components/smart-logo', () => ({ default: () => null }));

import { act } from 'react';
import AuthPage from '../pages/auth-page';

beforeEach(() => {
  vi.clearAllMocks();
  widget.token = null;
  widget.waiters = [];
  signInWithPassword.mockResolvedValue({ error: new Error('Invalid login credentials') });
});

describe('sign-in with CAPTCHA enabled', () => {
  it('is clickable before the check finishes, waits for the token, then resets', async () => {
    render(<AuthPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'jane@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'secret-123');
    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect(submit).toBeEnabled();

    await userEvent.click(submit);
    expect(signInWithPassword).not.toHaveBeenCalled(); // still waiting on Cloudflare
    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();

    act(() => widget.finish('tok-1'));
    await waitFor(() => expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'jane@example.com',
      password: 'secret-123',
      options: { captchaToken: 'tok-1' },
    }));
    await waitFor(() => expect(resetSpy).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('uses a token that is already there without waiting', async () => {
    widget.token = 'tok-ready';
    render(<AuthPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'jane@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'secret-123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(signInWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({ options: { captchaToken: 'tok-ready' } }),
    ));
  });

  it('says so instead of sending a token-less request when the check fails', async () => {
    render(<AuthPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'jane@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'secret-123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    act(() => widget.finish(null));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't verify this browser/i);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
});
