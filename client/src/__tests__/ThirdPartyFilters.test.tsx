/**
 * Third-party jobs (staffing agencies, job boards) fill a feed whose filters leave no direct
 * jobs, under every filter, and never show a job outside the filters, even when the server
 * sends one or a filter changes after they were loaded.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

// One direct job: mid level, onsite in Portland, posted 10 days ago, Stretch.
const DIRECT = {
  id: 1, matchScore: '80%', skillMatches: [], aiExplanation: 'Good fit', verdict: verdict('stretch'),
  job: { id: 10, title: 'Nurse Direct', company: 'Acme', location: 'Portland, OR', locationKeys: ['portland|OR', 'state|OR'],
    workType: 'onsite', postedDate: ago(240), externalUrl: 'https://jobs.lever.co/acme/1', skills: [], requirements: [] },
};
// Third-party jobs as a careless server might send them: each fails a different filter.
const tp = (id: number, title: string, o: Record<string, unknown>) => ({
  id, title, company: `Agency ${id}`, source: 'Adzuna', thirdPartyKind: 'agency', externalUrl: `https://x.test/${id}`,
  location: 'Seattle, WA', locationKeys: ['seattle|WA', 'state|WA'], workType: 'remote', postedAt: ago(2), verdict: verdict('apply'), ...o,
});
const THIRD = [
  tp(901, 'Fresh Remote Nurse', {}),                                    // passes everything below
  tp(902, 'Old Nurse', { postedAt: ago(200) }),                         // fails Past 24 hours
  tp(903, 'Skip Nurse', { verdict: verdict('skip') }),                  // fails verdict Apply
  tp(904, 'Senior Nurse', {}),                                          // fails level Mid
  tp(905, 'Boston Nurse', { location: 'Boston, MA', locationKeys: ['boston|MA', 'state|MA'] }),
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
let calls: string[] = [];
let directJobs: unknown[] = [DIRECT];

beforeEach(() => {
  calls = [];
  directJobs = [DIRECT];
  mockApiRequest.mockReset();
  mockApiRequest.mockImplementation(async (_m: string, url: string) => {
    calls.push(url);
    if (url.startsWith('/api/ai-matches')) {
      // The server applies date posted: the direct job is 10 days old.
      const within = new URL(url, 'http://x').searchParams.get('postedWithin');
      const jobs = within && Number(within) < 10 ? [] : directJobs;
      return json({ jobs, total: jobs.length, page: 1, hasMore: false });
    }
    if (url === '/api/candidate/job-actions') {return json({ saved: [], applied: [] });}
    if (url.startsWith('/api/third-party-matches')) {return json({ jobs: THIRD });}
    return json({});
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
});
afterEach(() => { vi.unstubAllGlobals(); });

function renderFeed() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AIJobFeed /></QueryClientProvider>);
}
async function pick(option: string) {
  fireEvent.click(await screen.findByRole('option', { name: option }));
}
const shown = () => THIRD.map(j => j.title).filter(t => screen.queryByText(t));
const thirdPartyCalls = () => calls.filter(u => u.startsWith('/api/third-party-matches'));

describe('third-party jobs under filters', () => {
  it('fill an empty "Past 24 hours" feed, asked for and shown only within 24 hours', async () => {
    renderFeed();
    await screen.findByText('Nurse Direct');
    expect(thirdPartyCalls()).toHaveLength(0);  // direct jobs: no third-party
    await pick('Past 24 hours');
    expect(await screen.findByText('No direct jobs fit your filters. Here are third-party listings that do.')).toBeInTheDocument();
    await waitFor(() => expect(thirdPartyCalls().some(u => u.includes('postedWithin=1'))).toBe(true));
    expect(shown()).not.toContain('Old Nurse');
    expect(shown()).toContain('Fresh Remote Nurse');
  });

  it('follow the verdict filter (asked for and checked)', async () => {
    renderFeed();
    await screen.findByText('Nurse Direct');
    await pick('Apply');
    await screen.findByText('Fresh Remote Nurse');
    expect(thirdPartyCalls().some(u => u.includes('verdict=apply'))).toBe(true);
    expect(shown()).not.toContain('Skip Nurse');
  });

  it('follow the level filter', async () => {
    renderFeed();
    await screen.findByText('Nurse Direct');
    await pick('Lead');  // the direct job is mid level
    await waitFor(() => expect(thirdPartyCalls().some(u => u.includes('level=lead'))).toBe(true));
    // None of the third-party titles reads as lead: nothing shows, and the feed says so.
    expect(await screen.findByText('No direct matches fit your filters')).toBeInTheDocument();
    expect(shown()).toEqual([]);
  });

  it('follow work type and search, and never relax them', async () => {
    renderFeed();
    await screen.findByText('Nurse Direct');
    await pick('Remote');
    await screen.findByText('Fresh Remote Nurse');
    fireEvent.change(screen.getByPlaceholderText('Search jobs...'), { target: { value: 'boston' } });
    await waitFor(() => expect(shown()).toEqual(['Boston Nurse']));
    await waitFor(() => expect(thirdPartyCalls().some(u => u.includes('search=boston') && u.includes('workType=remote'))).toBe(true));
  });

  it('do not show cards loaded for other filters (a filter changed after loading)', async () => {
    directJobs = [];  // no direct jobs at all: third-party with no filters
    renderFeed();
    expect(await screen.findByText('No direct matches yet. Here are third-party listings.')).toBeInTheDocument();
    expect(shown()).toHaveLength(5);
    await pick('Apply');
    await pick('Past 24 hours');
    // Wait for the feed to settle (it shows a loader while refetching), then check.
    await screen.findByText(/fit your filters/);
    await screen.findByText('Fresh Remote Nurse');
    expect(shown()).toEqual(['Fresh Remote Nurse', 'Senior Nurse', 'Boston Nurse']);
  });

  it('are not used under a company filter (its list is direct employers)', async () => {
    renderFeed();
    await screen.findByText('Nurse Direct');
    await pick('Acme');
    fireEvent.change(screen.getByPlaceholderText('Search jobs...'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No direct matches fit your filters')).toBeInTheDocument();
    await new Promise(r => setTimeout(r, 600));
    expect(thirdPartyCalls()).toHaveLength(0);
    expect(shown()).toEqual([]);
  });

  it('keep "Clear filters" readable as text (phones too) and clearing brings direct jobs back', async () => {
    renderFeed();
    await screen.findByText('Nurse Direct');
    await pick('Past 24 hours');
    const clear = await screen.findByRole('button', { name: 'Clear filters' });
    expect(clear.querySelector('.hidden')).toBeNull();
    fireEvent.click(clear);
    expect(await screen.findByText('Nurse Direct')).toBeInTheDocument();
    expect(shown()).toEqual([]);
  });
});
