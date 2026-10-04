/**
 * The honest verdict on feed cards: Apply / Stretch / Skip with the reason,
 * and what the candidate should answer in Settings so we can check the rest.
 */
import { render, screen, within } from '@testing-library/react';
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

const job = (id: number, title: string, verdict: unknown) => ({
  id, matchScore: '78%', skillMatches: [], aiExplanation: 'Good fit', verdict,
  job: { id: id * 10, title, company: 'Acme', location: 'Remote', workType: 'remote', externalUrl: `https://jobs.lever.co/acme/${id}`, skills: [], requirements: [] },
});
const JOBS = [
  job(1, 'Support Engineer', { label: 'apply', reasons: ['You meet the stated requirements'], toCheck: [] }),
  job(2, 'Help Desk Technician', { label: 'stretch', reasons: ['Asks for 5+ years; you have about 4'], toCheck: [] }),
  job(3, 'Cleared Systems Admin', { label: 'apply', reasons: ['You meet the stated requirements'], toCheck: ['Requires an active Secret clearance'] }),
  job(4, 'DRSN Technician', { label: 'skip', reasons: ['Requires an active Top Secret clearance'], toCheck: [] }),
];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  mockApiRequest.mockReset();
  mockApiRequest.mockImplementation(async (_m: string, url: string) =>
    url.startsWith('/api/ai-matches') ? json({ jobs: JOBS, total: JOBS.length, page: 1, hasMore: false })
      : url === '/api/candidate/job-actions' ? json({ saved: [], applied: [] }) : json({}));
});

function renderFeed() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AIJobFeed /></QueryClientProvider>);
}

describe('job verdicts', () => {
  it('shows each verdict with its reason', async () => {
    renderFeed();
    await screen.findByText('Support Engineer');
    const verdicts = screen.getAllByTestId('job-verdict');
    expect(verdicts).toHaveLength(4);
    expect(within(verdicts[1]).getByText('Stretch')).toBeInTheDocument();
    expect(within(verdicts[1]).getByText('Asks for 5+ years; you have about 4')).toBeInTheDocument();
    expect(within(verdicts[3]).getByText('Skip')).toBeInTheDocument();
    expect(within(verdicts[3]).getByText('Requires an active Top Secret clearance')).toBeInTheDocument();
  });

  it('points to Settings when the job depends on an unanswered question', async () => {
    renderFeed();
    expect(await screen.findByTestId('job-verdict-check')).toHaveTextContent('Check: Requires an active Secret clearance');
    expect(screen.getByTestId('job-verdict-check')).toHaveTextContent('Settings → Application answers');
  });
});
