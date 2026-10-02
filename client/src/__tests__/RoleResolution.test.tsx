/**
 * Where a signed-in user's role is read from.
 *
 * Written after a real Google signup on 2026-09-30 uploaded the same résumé
 * three times in three minutes and then hit the daily upload limit. Google
 * accounts have no `user_metadata.role`; POST /api/auth/role stores it in
 * `app_metadata`, which the browser's token only picks up when it refreshes.
 * So finishing onboarding sent RoleGuard's check to an empty role, back to
 * /role-selection, and into step 1 again — and every later sign-in at /auth
 * did the same, because /auth read `user_metadata` alone.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getUserRole } from '@/lib/auth-role';

describe('getUserRole', () => {
  it('reads an email signup from user_metadata', () => {
    expect(getUserRole({ user_metadata: { role: 'candidate' } })).toBe('candidate');
  });

  it('reads a Google signup from app_metadata', () => {
    expect(getUserRole({ user_metadata: {}, app_metadata: { role: 'candidate' } })).toBe('candidate');
  });

  it('falls back to the users-row role merged in by useAuth', () => {
    expect(getUserRole({ user_metadata: {}, app_metadata: {}, role: 'candidate' })).toBe('candidate');
  });

  it('ignores values that are not roles', () => {
    expect(getUserRole({ user_metadata: { role: 'admin' }, app_metadata: { role: '' } })).toBeNull();
    expect(getUserRole(null)).toBeNull();
  });
});

const mockAuth = vi.fn();
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => mockAuth() }));
const mockSetLocation = vi.fn();
vi.mock('wouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('wouter')>()),
  useLocation: () => ['/candidate-dashboard', mockSetLocation],
}));

import { RoleGuard } from '@/components/role-guard';

describe('RoleGuard', () => {
  beforeEach(() => {
    mockSetLocation.mockReset();
  });

  it('lets a Google candidate into the dashboard before their token refreshes', async () => {
    // The token predates POST /api/auth/role, so it carries no role at all;
    // only the users row (merged in by useAuth) knows.
    mockAuth.mockReturnValue({
      isLoading: false,
      isAuthenticated: true,
      user: { id: 'u1', user_metadata: {}, app_metadata: {}, role: 'candidate' },
    });
    render(<RoleGuard allowedRoles={['candidate']}><div>DASHBOARD</div></RoleGuard>);

    expect(screen.getByText('DASHBOARD')).toBeInTheDocument();
    expect(mockSetLocation).not.toHaveBeenCalledWith('/role-selection');
  });

  it('still sends an account with no role anywhere to role selection', async () => {
    mockAuth.mockReturnValue({
      isLoading: false,
      isAuthenticated: true,
      user: { id: 'u1', user_metadata: {}, app_metadata: {} },
    });
    render(<RoleGuard allowedRoles={['candidate']}><div>DASHBOARD</div></RoleGuard>);

    await waitFor(() => expect(mockSetLocation).toHaveBeenCalledWith('/role-selection'));
    expect(screen.queryByText('DASHBOARD')).not.toBeInTheDocument();
  });
});

const mockApiRequest = vi.fn();
vi.mock('@/lib/queryClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queryClient')>()),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));
const mockRefreshSession = vi.fn();
vi.mock('@/lib/supabase-client', () => ({
  supabase: { auth: { refreshSession: () => mockRefreshSession() } },
}));
const mockSetRole = vi.fn();
vi.mock('@/contexts/GuidedSetupContext', () => ({
  useGuidedSetup: () => ({ setRole: mockSetRole, setStep: vi.fn() }),
}));

import RoleSelectionStep from '@/components/guided-setup/RoleSelectionStep';

function renderStep() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RoleSelectionStep />
    </QueryClientProvider>,
  );
}

describe('RoleSelectionStep (candidate-only mode)', () => {
  beforeEach(() => {
    mockApiRequest.mockReset();
    mockRefreshSession.mockReset();
    mockRefreshSession.mockResolvedValue({ data: {}, error: null });
    mockSetRole.mockReset();
  });

  it('refreshes the session once the role is saved, before starting the flow', async () => {
    mockApiRequest.mockResolvedValue(new Response('{}', { status: 200 }));
    renderStep();

    await waitFor(() => expect(mockSetRole).toHaveBeenCalledWith('candidate'));
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(mockRefreshSession.mock.invocationCallOrder[0])
      .toBeLessThan(mockSetRole.mock.invocationCallOrder[0]);
  });

  it('treats an HTTP error from the role save as a failure', async () => {
    // apiRequest resolves on any status; a 500 used to start the candidate
    // flow for an account the server had stored no role for.
    mockApiRequest.mockResolvedValue(new Response('{"message":"Failed to set user role"}', { status: 500 }));
    renderStep();

    await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument());
    expect(mockSetRole).not.toHaveBeenCalled();
  });
});
