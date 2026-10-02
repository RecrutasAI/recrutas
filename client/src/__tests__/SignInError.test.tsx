/**
 * The "which email did I use?" hint belongs to a failed sign-in, not to the
 * form: it's shown only after Supabase rejects the credentials, and goes away
 * as soon as the user edits a field.
 */
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { signInWithPassword } = vi.hoisted(() => ({ signInWithPassword: vi.fn() }));
vi.mock('@supabase/auth-helpers-react', () => ({
  useSupabaseClient: () => ({ auth: { signInWithPassword } }),
  useSession: () => null,
}));
vi.mock('@/components/google-sign-in-button', () => ({
  GoogleSignInButton: () => <button type="button">Continue with Google</button>,
  OrDivider: () => null,
}));
vi.mock('@/components/smart-logo', () => ({ default: () => null }));

import AuthPage from '../pages/auth-page';

async function signIn(email = 'jane@example.com', password = 'wrong-pass') {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => vi.clearAllMocks());

describe('sign-in failure message', () => {
  it('shows no hint before any attempt', () => {
    render(<AuthPage />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/support@recrutas.ai/)).not.toBeInTheDocument();
  });

  it('shows the which-email hint after wrong credentials', async () => {
    signInWithPassword.mockResolvedValue({ error: new Error('Invalid login credentials') });
    render(<AuthPage />);
    await signIn();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("That email and password don't match.");
    expect(alert).toHaveTextContent('support@recrutas.ai');
  });

  it('clears the message once the user edits a field', async () => {
    signInWithPassword.mockResolvedValue({ error: new Error('Invalid login credentials') });
    render(<AuthPage />);
    await signIn();
    await screen.findByRole('alert');
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('shows other errors as-is, without the email hint', async () => {
    signInWithPassword.mockResolvedValue({ error: new Error('Email rate limit exceeded') });
    render(<AuthPage />);
    await signIn();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Email rate limit exceeded');
    expect(alert).not.toHaveTextContent('support@recrutas.ai');
  });

  it('holds the loading screen, not the form, while a Google return is finished', () => {
    // Supabase parses #access_token after the first render; the form used to
    // flash up in between, which read as the sign-in bouncing back.
    window.history.replaceState(null, '', '/auth#access_token=abc&refresh_token=def&token_type=bearer');
    render(<AuthPage />);
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    window.history.replaceState(null, '', '/');
  });

  it('falls back to the form if the Google return never yields a session', () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/auth#access_token=abc');
    render(<AuthPage />);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
  });

  it('treats ?code=REDDIT-… as an attribution tag, not a Google return', () => {
    window.history.replaceState(null, '', '/auth?code=REDDIT-A1B2');
    render(<AuthPage />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    window.history.replaceState(null, '', '/');
  });

  it('shows a failed Google sign-in that Supabase sent back in the URL', () => {
    window.history.replaceState(null, '', '/auth?error=server_error&error_description=Unable+to+exchange+external+code%3A+x#error=server_error');
    render(<AuthPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('Google sign-in failed: Unable to exchange external code: x');
    window.history.replaceState(null, '', '/');
  });
});
