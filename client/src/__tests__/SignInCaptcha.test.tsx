/**
 * With CAPTCHA enabled in Supabase, a password sign-in without a token is
 * rejected. Simulates a configured site key: the button waits for a token,
 * the token is sent with the request, and the widget resets after each try
 * (tokens are single-use).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { forwardRef, useImperativeHandle } from 'react';

const { signInWithPassword, resetSpy, emit } = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  resetSpy: vi.fn(),
  emit: { token: (_t: string | null) => {} },
}));

vi.mock('@/components/turnstile', () => ({
  captchaEnabled: true,
  Turnstile: forwardRef(function FakeTurnstile({ onToken }: { onToken: (t: string | null) => void }, ref) {
    emit.token = onToken;
    useImperativeHandle(ref, () => ({ reset: () => { resetSpy(); onToken(null); } }));
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
  signInWithPassword.mockResolvedValue({ error: new Error('Invalid login credentials') });
});

describe('sign-in with CAPTCHA enabled', () => {
  it('waits for a token, sends it, then resets the widget', async () => {
    render(<AuthPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'jane@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'secret-123');
    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect(submit).toBeDisabled();

    act(() => emit.token('tok-1'));
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    await waitFor(() => expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'jane@example.com',
      password: 'secret-123',
      options: { captchaToken: 'tok-1' },
    }));
    await waitFor(() => expect(resetSpy).toHaveBeenCalled());
    expect(submit).toBeDisabled(); // needs a fresh token for the next attempt
  });
});
