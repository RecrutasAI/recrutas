import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { server } from '../mocks/server';
import { PersonalMarket, oneIn, shutOutChips, type PersonalMarketData } from '../components/site/personal-market';
import { DEMO_ANSWERS_KEY, readDemoAnswers, mergeDemoAnswers } from '../lib/demo-answers';

const now = Date.now();
const base: PersonalMarketData = {
  scope: 'role', live: 1429, answered: false, eligible: null, restrictedShare: 0.14,
  shutOut: { citizenship: 0, clearance: 0, sponsorship: 0, years: 0 },
  openedLast24h: 212, closedLast24h: 87, sparkline: [1300, 1350, 1400, 1380, 1410, 1420, 1429],
  lastBoardRead: new Date(now - 40 * 60e3).toISOString(), nextBoardRead: new Date(now + 80 * 60e3).toISOString(),
  events: [{ type: 'new', at: new Date(now - 3600e3).toISOString(), title: 'IT Support Engineer', company: 'PubMatic', location: 'Seattle, WA', workType: 'onsite', externalUrl: 'https://jobs.lever.co/pubmatic/1', flags: [], verdict: { label: 'skip', reason: 'Requires an active Secret clearance.' } }],
};

let lastQuery: URLSearchParams | null = null;
function serve(data: (q: URLSearchParams) => PersonalMarketData) {
  server.use(http.get('/api/platform/my-market', ({ request }) => {
    lastQuery = new URL(request.url).searchParams;
    return HttpResponse.json(data(lastQuery));
  }));
}
const renderIt = (onStart = () => {}) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PersonalMarket onStart={onStart} />
  </QueryClientProvider>,
);

beforeEach(() => { lastQuery = null; localStorage.clear(); });
afterEach(() => server.resetHandlers());

describe('PersonalMarket', () => {
  it('asks first and shows nothing until a role is given', () => {
    serve(() => base);
    renderIt();
    expect(screen.getByLabelText('What do you do?')).toBeInTheDocument();
    expect(screen.queryByTestId('pm-headline')).toBeNull();
    expect(screen.queryByTestId('pm-facts')).toBeNull();
  });

  it('shows the live count and how many are restricted before any answers', async () => {
    serve(() => base);
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'IT support' }));
    const head = await screen.findByTestId('pm-headline');
    expect(head).toHaveTextContent('1,429 live IT support jobs.');
    expect(head).toHaveTextContent('1 in 7 require US citizenship or a clearance.');
    expect(screen.getByText('Requires an active Secret clearance.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /See your matches/ })).toBeInTheDocument();
  });

  it('sends the answers and shows what is open, with the reasons the rest are shut', async () => {
    serve(q => (q.get('citizen') ? { ...base, answered: true, eligible: 1214, shutOut: { citizenship: 150, clearance: 40, sponsorship: 0, years: 25 } } : base));
    let started = false;
    renderIt(() => { started = true; });
    fireEvent.click(screen.getByRole('button', { name: 'IT support' }));
    await screen.findByTestId('pm-headline');
    fireEvent.click(screen.getAllByRole('button', { name: 'no' })[0]); // US citizen? no
    await waitFor(() => expect(screen.getByTestId('pm-headline')).toHaveTextContent('You can apply to 1,214 of 1,429 live IT support jobs.'));
    expect(lastQuery?.get('citizen')).toBe('no');
    expect(screen.getByTestId('pm-shutout')).toHaveTextContent('150 need US citizenship');
    fireEvent.click(screen.getByRole('button', { name: /See the 1,214 you can apply to/ }));
    expect(started).toBe(true);
    expect(readDemoAnswers(localStorage.getItem(DEMO_ANSWERS_KEY))).toEqual({ usCitizen: 'no' });
  });

  it('says plainly when the search is rate-limited', async () => {
    server.use(http.get('/api/platform/my-market', () => HttpResponse.json({}, { status: 429 })));
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'Nurse' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in a minute');
  });
});

describe('personal market helpers', () => {
  it('turns a share into 1 in N', () => {
    expect(oneIn(0.14)).toBe('1 in 7');
    expect(oneIn(0.9)).toBe('1 in 2');
    expect(oneIn(0)).toBe('');
  });
  it('lists only reasons that shut jobs out, largest first', () => {
    expect(shutOutChips({ citizenship: 5, clearance: 0, sponsorship: 30, years: 1 }))
      .toEqual(["30 won't sponsor a visa", '5 need US citizenship', '1 want more years']);
  });
});

describe('demo answers carry-over', () => {
  it('keeps only valid, recent answers', () => {
    expect(readDemoAnswers(JSON.stringify({ usCitizen: 'yes', needsSponsorship: 'maybe', securityClearance: 'none', at: now }), now))
      .toEqual({ usCitizen: 'yes', securityClearance: 'none' });
    expect(readDemoAnswers(JSON.stringify({ usCitizen: 'yes', at: now - 8 * 86400e3 }), now)).toBeNull();
    expect(readDemoAnswers('not json')).toBeNull();
    expect(readDemoAnswers(null)).toBeNull();
  });
  it('never overwrites an answer the candidate already gave', () => {
    expect(mergeDemoAnswers({ usCitizen: 'yes' }, { usCitizen: 'no', needsSponsorship: 'no' })).toEqual({ usCitizen: 'yes', needsSponsorship: 'no' });
    expect(mergeDemoAnswers({ usCitizen: 'yes' }, { usCitizen: 'no' })).toBeNull();
  });
});
