/**
 * "Apply Externally" on the real feed component.
 *
 * Clicking it used to record an application immediately — before the candidate
 * had even seen the company's form — and opened the posting from a 500ms timer,
 * which Safari's popup blocker refuses. Now the posting opens inside the click
 * and the application is only recorded when the candidate says they applied.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockApiRequest = vi.fn();
vi.mock('@/lib/queryClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queryClient')>()),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../components/AIMatchBreakdownModal', () => ({ default: () => null }));

import AIJobFeed from '../components/ai-job-feed';

const EXTERNAL_JOB = {
  id: 1,
  job: {
    id: 501,
    title: 'Support Engineer',
    company: 'Acme',
    location: 'Remote',
    workType: 'remote',
    externalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
    skills: [],
    requirements: [],
  },
  matchScore: '80%',
  skillMatches: [],
  aiExplanation: 'Good fit',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function respond(method: string, url: string) {
  if (url.startsWith('/api/ai-matches')) {return json({ jobs: [EXTERNAL_JOB], total: 1, page: 1, hasMore: false });}
  if (url === '/api/candidate/job-actions') {return json({ saved: [], applied: [] });}
  if (method === 'POST' && url.startsWith('/api/candidate/apply/')) {return json({ id: 9 });}
  return json({});
}

function renderFeed() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AIJobFeed />
    </QueryClientProvider>,
  );
}

const applyCalls = () => mockApiRequest.mock.calls.filter(([m, u]) => m === 'POST' && String(u).startsWith('/api/candidate/apply/'));

describe('Apply Externally', () => {
  beforeEach(() => {
    mockApiRequest.mockReset();
    mockApiRequest.mockImplementation(async (method: string, url: string) => respond(method, url));
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  it('opens the posting in the click and records nothing yet', async () => {
    renderFeed();
    await userEvent.click(await screen.findByRole('button', { name: /apply externally/i }));

    expect(window.open).toHaveBeenCalledWith(EXTERNAL_JOB.job.externalUrl, '_blank', 'noopener,noreferrer');
    expect(applyCalls()).toHaveLength(0);
    expect(screen.getByText(/did you apply at acme/i)).toBeInTheDocument();
  });

  it('records the application only when the candidate confirms', async () => {
    renderFeed();
    await userEvent.click(await screen.findByRole('button', { name: /apply externally/i }));
    await userEvent.click(screen.getByRole('button', { name: /yes, mark applied/i }));

    await waitFor(() => expect(applyCalls()).toHaveLength(1));
    expect(applyCalls()[0][1]).toBe('/api/candidate/apply/501');
  });

  it('"Not yet" dismisses the question without recording anything', async () => {
    renderFeed();
    await userEvent.click(await screen.findByRole('button', { name: /apply externally/i }));
    await userEvent.click(screen.getByRole('button', { name: /not yet/i }));

    expect(screen.queryByText(/did you apply at acme/i)).not.toBeInTheDocument();
    expect(applyCalls()).toHaveLength(0);
  });
});
