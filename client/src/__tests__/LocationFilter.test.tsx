/**
 * The feed's location filter, as a person uses it: typing never filters, picking a place does,
 * every job resolved to that place shows however its post wrote the location, and a place with
 * no direct matches says so instead of swapping in third-party jobs.
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

import AIJobFeed from '../components/ai-job-feed';
import { pickedKey } from '@shared/places';

const PLACES = {
  places: [['Seattle', 'WA', 6737], ['San Francisco', 'CA', 13485], ['Seaside', 'OR', 12], ['Portland', 'OR', 2984], ['Portland', 'ME', 529], ['Searcy', 'AR', 0]],
  states: [['Washington', 'WA', 20000], ['Oregon', 'OR', 5000]],
};

const job = (id: number, title: string, location: string, locationKeys: string[]) => ({
  id, matchScore: '80%', skillMatches: [], aiExplanation: 'Good fit',
  job: { id: id * 10, title, company: 'Acme', location, locationKeys, workType: 'onsite', externalUrl: `https://jobs.lever.co/acme/${id}`, skills: [], requirements: [] },
});
const JOBS = [
  job(1, 'Nurse A', 'Seattle, WA', ['seattle|WA', 'state|WA']),
  job(2, 'Nurse B', 'Onsite - Seattle', ['seattle|WA', 'state|WA']),
  job(3, 'Nurse C', 'Greater Seattle Area', ['seattle|WA', 'state|WA']),
  job(4, 'Nurse D', 'Portland, OR', ['portland|OR', 'state|OR']),
  job(5, 'Nurse E', 'Portland, ME', ['portland|ME', 'state|ME']),
];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  mockApiRequest.mockReset();
  mockApiRequest.mockImplementation(async (_m: string, url: string) => {
    calls.push(url);
    if (url.startsWith('/api/ai-matches')) {
      // The server filters on the same keys.
      const loc = new URL(url, 'http://x').searchParams.get('location');
      const key = pickedKey(loc);
      const jobs = key ? JOBS.filter(j => j.job.locationKeys.includes(key)) : JOBS;
      return json({ jobs, total: jobs.length, page: 1, hasMore: false });
    }
    if (url === '/api/candidate/job-actions') {return json({ saved: [], applied: [] });}
    if (url.startsWith('/api/third-party-matches')) {return json({ jobs: [{ id: 999, title: 'Agency Nurse', company: 'Staffing Co', location: 'Seattle, WA', thirdPartyKind: 'agency', source: 'Adzuna' }] });}
    return json({});
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/us-places.json' ? json(PLACES) : new Response('', { status: 404 }))));
});
afterEach(() => { vi.unstubAllGlobals(); });

function renderFeed() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AIJobFeed /></QueryClientProvider>);
}
const box = () => screen.getByRole('combobox', { name: 'Location' });
const visible = () => ['Nurse A', 'Nurse B', 'Nurse C', 'Nurse D', 'Nurse E'].filter(t => screen.queryByText(t));

describe('location filter', () => {
  it('does not filter while typing', async () => {
    renderFeed();
    await screen.findByText('Nurse A');
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 's' } });
    await new Promise(r => setTimeout(r, 600));
    expect(visible()).toHaveLength(5);
    expect(calls.some(u => u.includes('location='))).toBe(false);
    expect(calls.some(u => u.startsWith('/api/third-party-matches'))).toBe(false);
  });

  it('suggests real places with their job counts, most jobs first', async () => {
    renderFeed();
    await screen.findByText('Nurse A');
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'sea' } });
    const options = await screen.findAllByRole('option');
    expect(options.map(o => o.textContent)).toEqual(['Seattle, WA6,737 jobs', 'Seaside, OR12 jobs', 'Searcy, ARno jobs yet']);
  });

  it('shows every job in the picked city however the post wrote it, and nothing else', async () => {
    renderFeed();
    await screen.findByText('Nurse A');
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'seat' } });
    fireEvent.click(await screen.findByRole("option", { name: /Seattle, WA/ }));
    await waitFor(() => expect(visible()).toEqual(['Nurse A', 'Nurse B', 'Nurse C']));
    expect(box()).toHaveValue('Seattle, WA');
    await waitFor(() => expect(calls.some(u => u.includes('location=Seattle%2C+WA'))).toBe(true));
  });

  it('tells Portland, OR from Portland, ME', async () => {
    renderFeed();
    await screen.findByText('Nurse A');
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'portland' } });
    fireEvent.click(await screen.findByRole('option', { name: /Portland, ME/ }));
    await waitFor(() => expect(visible()).toEqual(['Nurse E']));
  });

  it('picks the highlighted place on Enter once the name is clear, and a state by its code', async () => {
    renderFeed();
    await screen.findByText('Nurse A');
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'se' } });
    await screen.findAllByRole('option');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(visible()).toHaveLength(5);                       // "se" is not a choice yet
    fireEvent.change(box(), { target: { value: 'WA' } });
    await screen.findByRole('option', { name: /Washington \(state\)/ });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(visible()).toEqual(['Nurse A', 'Nurse B', 'Nurse C']));
    expect(box()).toHaveValue('Washington (state)');
  });

  it('puts back the applied place when the box is left without choosing', async () => {
    renderFeed();
    await screen.findByText('Nurse A');
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'portl' } });
    fireEvent.blur(box());
    expect(box()).toHaveValue('');
    expect(visible()).toHaveLength(5);
  });

  it('says a place has no direct matches, offers to clear it, and never shows third-party jobs for it', async () => {
    renderFeed();
    await screen.findByText('Nurse A');
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'san fr' } });
    fireEvent.click(await screen.findByRole('option', { name: /San Francisco, CA/ }));
    expect(await screen.findByText('No direct matches in San Francisco, CA')).toBeInTheDocument();
    expect(screen.queryByText('Agency Nurse')).toBeNull();
    expect(calls.some(u => u.startsWith('/api/third-party-matches'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }));
    await waitFor(() => expect(visible()).toHaveLength(5));
  });

  it('shows third-party jobs only when the person has no direct matches at all', async () => {
    mockApiRequest.mockImplementation(async (_m: string, url: string) => {
      calls.push(url);
      if (url.startsWith('/api/ai-matches')) {return json({ jobs: [], total: 0, page: 1, hasMore: false });}
      if (url === '/api/candidate/job-actions') {return json({ saved: [], applied: [] });}
      if (url.startsWith('/api/third-party-matches')) {return json({ jobs: [{ id: 999, title: 'Agency Nurse', company: 'Staffing Co', location: 'Seattle, WA', thirdPartyKind: 'agency', source: 'Adzuna', externalUrl: 'https://x.test/1' }] });}
      return json({});
    });
    renderFeed();
    expect(await screen.findByText('Agency Nurse')).toBeInTheDocument();
  });
});
