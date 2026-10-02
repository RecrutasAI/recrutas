/**
 * Account basics a candidate must be able to do on their own: change email,
 * change (or, for Google sign-ups, set) a password, and delete the account.
 * None of these existed — the privacy policy promised account deletion with no
 * way to do it — so these tests render the real component, not a mock.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { auth, apiRequest, toast, session } = vi.hoisted(() => ({
  auth: {
    updateUser: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
  },
  apiRequest: vi.fn(),
  toast: vi.fn(),
  session: { current: null as any },
}));

vi.mock('@/lib/supabase-client', () => ({ supabase: { auth } }));
vi.mock('@/lib/queryClient', () => ({ apiRequest }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@supabase/auth-helpers-react', () => ({ useSession: () => session.current }));

import { AccountSettings } from '../components/account-settings';

const emailUser = {
  id: 'u1',
  email: 'jane@example.com',
  identities: [{ provider: 'email' }],
};
const googleUser = {
  id: 'u2',
  email: 'sam@gmail.com',
  identities: [{ provider: 'google' }],
};

function renderAccount(user: any) {
  session.current = { user };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AccountSettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.updateUser.mockResolvedValue({ error: null });
  auth.signInWithPassword.mockResolvedValue({ error: null });
  auth.signOut.mockResolvedValue({ error: null });
  apiRequest.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
});

describe('AccountSettings — email', () => {
  it('shows the current email and sends a confirmation link to the new one', async () => {
    renderAccount(emailUser);
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('button', { name: 'Change' })[0]);
    await userEvent.type(screen.getByLabelText('New email'), 'Jane.New@Example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send confirmation link' }));

    await waitFor(() => expect(auth.updateUser).toHaveBeenCalledTimes(1));
    const [attrs, opts] = auth.updateUser.mock.calls[0];
    expect(attrs).toEqual({ email: 'jane.new@example.com' });
    expect(opts.emailRedirectTo).toMatch(/\/candidate-dashboard$/);
  });

  it('refuses a "change" to the same address', async () => {
    renderAccount(emailUser);
    await userEvent.click(screen.getAllByRole('button', { name: 'Change' })[0]);
    await userEvent.type(screen.getByLabelText('New email'), 'JANE@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send confirmation link' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })));
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
});

describe('AccountSettings — password', () => {
  async function openPassword() {
    await userEvent.click(screen.getAllByRole('button', { name: 'Change' })[1]);
  }

  it('re-verifies the current password before changing it', async () => {
    renderAccount(emailUser);
    await openPassword();
    await userEvent.type(screen.getByLabelText('Current password'), 'old-secret');
    await userEvent.type(screen.getByLabelText('New password'), 'new-secret-1');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'new-secret-1');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(auth.updateUser).toHaveBeenCalledWith({ password: 'new-secret-1' }));
    expect(apiRequest).toHaveBeenCalledWith('POST', '/api/account/verify-password', { password: 'old-secret' });
    expect(apiRequest.mock.invocationCallOrder[0])
      .toBeLessThan(auth.updateUser.mock.invocationCallOrder[0]);
    // Browser sign-in would need a CAPTCHA token; the check must go via the server.
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('does not change the password when the current one is wrong', async () => {
    apiRequest.mockResolvedValue({ ok: false, json: async () => ({}) });
    renderAccount(emailUser);
    await openPassword();
    await userEvent.type(screen.getByLabelText('Current password'), 'wrong');
    await userEvent.type(screen.getByLabelText('New password'), 'new-secret-1');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'new-secret-1');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Your current password is incorrect.',
    })));
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('rejects mismatched or too-short new passwords without calling Supabase', async () => {
    renderAccount(emailUser);
    await openPassword();
    await userEvent.type(screen.getByLabelText('Current password'), 'old-secret');
    await userEvent.type(screen.getByLabelText('New password'), 'new-secret-1');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'new-secret-2');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(apiRequest).not.toHaveBeenCalled();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('lets a Google sign-up set a password without asking for a current one', async () => {
    renderAccount(googleUser);
    expect(screen.getByText(/You sign in with Google/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('New password'), 'first-pass-1');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'first-pass-1');
    await userEvent.click(screen.getAllByRole('button', { name: 'Set password' }).at(-1)!);

    await waitFor(() => expect(auth.updateUser).toHaveBeenCalledWith({ password: 'first-pass-1' }));
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe('AccountSettings — delete account', () => {
  it('stays disabled until DELETE is typed, then deletes and signs out', async () => {
    apiRequest.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    renderAccount(emailUser);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const submit = screen.getByRole('button', { name: 'Delete my account' });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/to confirm/), 'delete');
    expect(submit).toBeDisabled(); // must be exact
    await userEvent.clear(screen.getByLabelText(/to confirm/));
    await userEvent.type(screen.getByLabelText(/to confirm/), 'DELETE');
    expect(submit).toBeEnabled();

    await userEvent.click(submit);
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
    expect(apiRequest).toHaveBeenCalledWith('DELETE', '/api/account', { confirm: 'DELETE' });
  });

  it('keeps the user signed in and shows the server message when deletion fails', async () => {
    apiRequest.mockResolvedValue({ ok: false, json: async () => ({ message: 'Nothing was removed' }) });
    renderAccount(emailUser);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.type(screen.getByLabelText(/to confirm/), 'DELETE');
    await userEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Nothing was removed',
    })));
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});
