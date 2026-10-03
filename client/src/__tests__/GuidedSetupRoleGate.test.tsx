/**
 * Guards which onboarding flow a user is shown.
 *
 * Written after finding that `/guided-setup` chose its flow with
 * `role === 'candidate' ? candidateSteps : talentOwnerSteps`. Because `role`
 * resolves from the session inside an effect, it is `null` on the first render
 * of every visit — so that ternary sent EVERY candidate into the employer flow
 * ("Company" / "Post a Job") until the session hydrated, and sent users with no
 * role metadata there permanently, with no way back: `RoleSelectionStep` existed
 * but was never imported.
 *
 * This matters more than a cosmetic glitch: it sits on the one step the phase-1
 * activation funnel is measured on (signup → resume upload), which was reading
 * 6 signups → 1 resume.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The step bodies each fetch and render heavy trees; this suite is about which
// flow gets chosen, so they are stubbed down to identifiable markers.
vi.mock('@/components/guided-setup/ResumeUploadStep', () => ({
  default: () => <div>STEP_RESUME</div>,
}));
vi.mock('@/components/guided-setup/SkillsStep', () => ({
  default: () => <div>STEP_SKILLS</div>,
}));
vi.mock('@/components/guided-setup/CompanyProfileStep', () => ({
  default: () => <div>STEP_COMPANY</div>,
}));
vi.mock('@/components/guided-setup/JobPostStep', () => ({
  default: () => <div>STEP_JOBPOST</div>,
}));
vi.mock('@/components/SignOutButton', () => ({
  SignOutButton: () => <button type="button">Sign out</button>,
}));
vi.mock('@/components/theme-toggle-button', () => ({
  ThemeToggleButton: () => <button type="button">Theme</button>,
}));

// Role saves go through apiRequest; stub it so the gate can be driven offline.
const mockApiRequest = vi.fn();
vi.mock('@/lib/queryClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queryClient')>()),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

const mockSession = vi.fn();
vi.mock('@supabase/auth-helpers-react', () => ({
  useSessionContext: () => mockSession(),
}));

import GuidedSetup from '../pages/guided-setup';

function renderSetup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <GuidedSetup />
    </QueryClientProvider>,
  );
}

const sessionWithRole = (role: string | undefined) => ({
  isLoading: false,
  session: { user: { id: 'u1', user_metadata: role ? { role } : {} } },
});

/** What Supabase actually returns while it is still hydrating from storage. */
const sessionHydrating = () => ({ isLoading: true, session: null });

describe('guided setup flow selection', () => {
  beforeEach(() => {
    mockSession.mockReset();
    mockApiRequest.mockReset();
    mockApiRequest.mockResolvedValue(new Response('{}'));
  });

  it('shows a candidate the resume step, never the employer flow', async () => {
    mockSession.mockReturnValue(sessionWithRole('candidate'));
    renderSetup();

    await waitFor(() => expect(screen.getByText('STEP_RESUME')).toBeInTheDocument());
    expect(screen.queryByText('STEP_COMPANY')).not.toBeInTheDocument();
    expect(screen.queryByText('STEP_JOBPOST')).not.toBeInTheDocument();
  });

  it('shows a talent owner the company step', async () => {
    mockSession.mockReturnValue(sessionWithRole('talent_owner'));
    renderSetup();

    await waitFor(() => expect(screen.getByText('STEP_COMPANY')).toBeInTheDocument());
    expect(screen.queryByText('STEP_RESUME')).not.toBeInTheDocument();
  });

  it('makes a role-less account a candidate, never an employer', async () => {
    // Employer signup is early access (its own page), so an account reaching
    // onboarding with no role — a first "Continue with Google" — is a candidate.
    // The old regression silently rendered the employer flow here.
    mockSession.mockReturnValue(sessionWithRole(undefined));
    renderSetup();

    await waitFor(() => expect(screen.getByText('STEP_RESUME')).toBeInTheDocument());
    expect(mockApiRequest).toHaveBeenCalledWith('POST', '/api/auth/role', { role: 'candidate' });
    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Talent Owner/i)).not.toBeInTheDocument();
    expect(screen.queryByText('STEP_COMPANY')).not.toBeInTheDocument();
    expect(screen.queryByText('STEP_JOBPOST')).not.toBeInTheDocument();
  });

  it('does not start the candidate flow until the role is saved', async () => {
    mockApiRequest.mockRejectedValue(new Error('network down'));
    mockSession.mockReturnValue(sessionWithRole(undefined));
    renderSetup();

    await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument());
    expect(screen.queryByText('STEP_RESUME')).not.toBeInTheDocument();

    mockApiRequest.mockResolvedValue(new Response('{}'));
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByText('STEP_RESUME')).toBeInTheDocument());
  });

  it('waits while the session hydrates instead of guessing a flow', async () => {
    // The real sequence: Supabase reports isLoading before it can say who this
    // is. Resolving the flow from that state is what produced both the employer
    // flash and, once a role gate existed, a spurious "Choose Your Role" for a
    // candidate who had already chosen one at signup.
    mockSession.mockReturnValue(sessionHydrating());
    const { container, rerender } = renderSetup();

    expect(container.textContent).not.toMatch(/Post Job|STEP_COMPANY|STEP_JOBPOST/);
    expect(screen.queryByText(/I'm a Candidate/i)).not.toBeInTheDocument();
    expect(container.textContent).toMatch(/Getting your account ready/i);

    // Session arrives.
    mockSession.mockReturnValue(sessionWithRole('candidate'));
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <GuidedSetup />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('STEP_RESUME')).toBeInTheDocument());
  });

  it('does not ask a candidate about "your company" on the profile step', async () => {
    mockSession.mockReturnValue(sessionWithRole('candidate'));
    const { container } = renderSetup();
    await waitFor(() => expect(screen.getByText('STEP_RESUME')).toBeInTheDocument());

    // The subtitle was hardcoded to the company line for every step past the
    // first, so it only misfires once the candidate advances — step 1 looks fine.
    await userEvent.click(screen.getByText('Profile'));
    await waitFor(() => expect(screen.getByText('STEP_SKILLS')).toBeInTheDocument());

    expect(container.textContent).not.toMatch(/your company/i);
  });
});
