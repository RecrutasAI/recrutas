/**
 * The feed explains itself: an empty filtered feed says which single filter to drop (and how
 * many jobs that brings back), and the order is named and can be switched to newest first.
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockApiRequest = vi.fn();
vi.mock('@/lib/queryClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queryClient')>()),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../components/AIMatchBreakdownModal', () => ({ default: () => null }));
// Radix Select doesn't open in jsdom: every option is a plain button that picks its value.
vi.mock('@/components/ui/select', async () => {
  const React = await import('react');
  const Ctx = React.createContext<(v: string) => void>(() => {});
  return {
    Select: ({ onValueChange, children }: any) => <Ctx.Provider value={onValueChange}><div>{children}</div></Ctx.Provider>,
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: any) => <div>{children}</div>,
    SelectItem: ({ value, children }: any) => {
      const pick = React.useContext(Ctx);
      return <button type="button" role="option" aria-selected={false} onClick={() => pick(value)}>{children}</button>;
    },
  };
});

import AIJobFeed from '../components/ai-job-feed';

const HOUR = 60 * 60 * 1000;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
const verdict = (label: string) => ({ label, reasons: ['r'], toCheck: [] });
const direct = (id: number, title: string, postedHoursAgo: number, label = 'stretch') => ({
  id, matchScore: '80%', skillMatches: [], aiExplanation: 'Good fit', verdict: verdict(label),
  job: { id: id * 10, title, company: 'Acme', location: 'Remote', workType: 'remote', postedDate: ago(postedHoursAgo),
    externalUrl: `https://jobs.lever.co/acme/${id}`, skills: [], requirements: [] },
});
// Server order (best match): the older job first.
const JOBS = [direct(1, 'Older Stretch Role', 240), direct(2, 'Newer Stretch Role', 5)];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
beforeEach(() => {
  mockApiRequest.mockReset();
  mockApiRequest.mockImplementation(async (_m: string, url: string) => {
    if (url.startsWith('/api/ai-matches')) {
      const within = new URL(url, 'http://x').searchParams.get('postedWithin');
      const jobs = within ? [] : JOBS;  // nothing posted in the asked window
      return json({ jobs, total: jobs.length, page: 1, hasMore: false });
    }
    if (url === '/api/candidate/job-actions') {return json({ saved: [], applied: [] });}
    if (url.startsWith('/api/third-party-matches')) {return json({ jobs: [] });}
    return json({});
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
});
afterEach(() => { vi.unstubAllGlobals(); });

function renderFeed(profile?: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (profile) {client.setQueryData(['/api/candidate/profile'], profile);}
  return render(<QueryClientProvider client={client}><AIJobFeed /></QueryClientProvider>);
}
const pick = async (option: string) => fireEvent.click(await screen.findByRole('option', { name: option }));
const titles = () => screen.queryAllByText(/Stretch Role$/).map(e => e.textContent);

describe('an empty filtered feed says which filter to drop', () => {
  it('counts what dropping a verdict filter brings back, and drops only that filter', async () => {
    renderFeed();
    await screen.findByText('Older Stretch Role');
    await pick('Apply');
    const relax = await screen.findByTestId('relax-filters');
    const drop = await within(relax).findByRole('button', { name: 'Without Apply · 2 jobs' });
    fireEvent.click(drop);
    expect(await screen.findByText('Older Stretch Role')).toBeInTheDocument();
  });

  it('offers a server-side filter (date posted) without a count', async () => {
    renderFeed();
    await screen.findByText('Older Stretch Role');
    await pick('Past 24 hours');
    const relax = await screen.findByTestId('relax-filters');
    fireEvent.click(await within(relax).findByRole('button', { name: 'Without Past 24 hours' }));
    expect(await screen.findByText('Older Stretch Role')).toBeInTheDocument();
  });
});

describe('the order is named and can be changed', () => {
  it('says how it ranks, and Newest puts the most recent posting first', async () => {
    renderFeed();
    await screen.findByText('Older Stretch Role');
    expect(screen.getByTestId('feed-order')).toHaveTextContent('Ranked by fit to your resume, then how fresh and trustworthy each posting is.');
    expect(titles()).toEqual(['Older Stretch Role', 'Newer Stretch Role']);
    await pick('Newest');
    await waitFor(() => expect(titles()).toEqual(['Newer Stretch Role', 'Older Stretch Role']));
    expect(screen.getByTestId('feed-order')).toHaveTextContent("Newest first, by the employer's own posting date.");
  });
});

describe('a profile without a location is asked for one', () => {
  const noLocation = { skills: ['Epic', 'Telemetry'], location: '', resumeParsingData: { personalInfo: { location: 'Tacoma, WA' } } };

  it('offers the resume location for confirmation and saves only on Save', async () => {
    renderFeed(noLocation);
    const prompt = await screen.findByTestId('location-prompt');
    expect(prompt).toHaveTextContent('Your resume says Tacoma, WA');
    expect(mockApiRequest.mock.calls.some(c => c[1] === '/api/candidate/profile' && c[0] === 'POST')).toBe(false);
    fireEvent.click(within(prompt).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockApiRequest).toHaveBeenCalledWith('POST', '/api/candidate/profile', { location: 'Tacoma, WA' }));
  });

  it('is not shown when the profile has a location', async () => {
    renderFeed({ ...noLocation, location: 'Seattle, WA' });
    await screen.findByText('Older Stretch Role');
    expect(screen.queryByTestId('location-prompt')).toBeNull();
  });
});
