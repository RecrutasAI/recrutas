/**
 * Guards how the résumé upload step reads processing status while it polls.
 *
 * /api/candidate/profile answers `{ exists, profile }`. This component used to
 * poll it with a raw fetch and read `resumeProcessingStatus` off the top level,
 * where it is always undefined — so the 'completed' and 'failed' branches could
 * never fire. Parsing finishes in about 20 seconds, but the upload sat spinning
 * until the 60-second timeout and was then reported to the user as "Processing
 * Taking Longer Than Expected".
 *
 * Both tests serve the real nested shape and assert on WHICH message the user
 * gets. That distinction is the whole point: a test that only checked "the flow
 * eventually advances" would pass against the bug, because the timeout branch
 * advances too — it just takes a minute and calls a success a failure.
 */
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const toasts: Array<{ title?: string; description?: string }> = [];
const setStep = vi.fn();

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: (t: any) => { toasts.push(t); } }),
}));
vi.mock('@/contexts/GuidedSetupContext', () => ({
  useGuidedSetup: () => ({ setStep }),
}));

// parsed:false with no extractedInfo is what sends the component down the
// polling path rather than the synchronous success path.
const uploadHandler = http.post('*/api/candidate/resume', () =>
  HttpResponse.json({
    resumeUrl: 'https://example.com/resume.pdf',
    parsed: false,
    aiParsing: { success: false, confidence: 0, processingTime: 0 },
    extractedInfo: null,
    autoMatchingTriggered: false,
  }),
);

/**
 * The real response envelope. Status is nested under `profile`, which is exactly
 * what a raw-body reader gets wrong.
 */
const profileServing = (status: string) =>
  http.get('*/api/candidate/profile', () =>
    HttpResponse.json({
      exists: true,
      profile: {
        userId: '123',
        resumeUrl: 'https://example.com/resume.pdf',
        resumeProcessingStatus: status,
        skills: ['React'],
      },
    }),
  );

// Reuse the GLOBAL server from setupTests.ts rather than standing up a second
// one. Two setupServer instances do not merge: the global one wins for any route
// both define, so a local handler for /api/candidate/profile is silently dead —
// which is precisely how four CandidateDashboard tests came to fail on a fixture
// nobody was reading.
import { server } from '../mocks/server';

beforeEach(() => {
  server.use(uploadHandler);
  toasts.length = 0;
  setStep.mockClear();
  localStorage.clear();
});
afterEach(() => {
  // Unmount before resetting handlers: the component polls on an interval, and a
  // survivor from the previous test would keep hitting the next test's handlers.
  cleanup();
  server.resetHandlers();
});

import ResumeUploadStep from '../components/guided-setup/ResumeUploadStep';

async function uploadAFile() {
  const user = userEvent.setup();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <ResumeUploadStep />
    </QueryClientProvider>,
  );
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['%PDF-1.4 fake'], 'resume.pdf', { type: 'application/pdf' });
  await user.upload(input, file);
  await user.click(screen.getByRole('button', { name: /upload and continue/i }));
}

const titles = () => toasts.map(t => t.title);

describe('résumé upload polling', () => {
  it('reports a completed parse as success, not as a timeout', async () => {
    server.use(profileServing('completed'));
    await uploadAFile();

    // Polls every 3s. Against the old raw-body read this never arrives, because
    // the status was undefined and only the 60s timeout branch could fire.
    await waitFor(
      () => expect(titles()).toContain('Resume Analyzed Successfully'),
      { timeout: 15000 },
    );

    expect(titles()).not.toContain('Processing Taking Longer Than Expected');
    // The component advances after a deliberate 1.5s pause on the success state.
    await waitFor(() => expect(setStep).toHaveBeenCalled(), { timeout: 5000 });
  }, 30000);

  it('reports a failed parse as a failure', async () => {
    server.use(profileServing('failed'));
    await uploadAFile();

    await waitFor(
      () => expect(titles()).toContain('Resume Processing Issue'),
      { timeout: 15000 },
    );

    expect(titles()).not.toContain('Resume Analyzed Successfully');
    expect(titles()).not.toContain('Processing Taking Longer Than Expected');
  }, 30000);
});
