import { render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, it, expect, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { server } from '../mocks/server';
import { MarketRadar, collapseEvents, ago, type RadarEvent } from '../components/site/market-radar';

const now = Date.now();
const ev = (o: Partial<RadarEvent>): RadarEvent => ({ type: 'new', at: new Date(now - 3 * 3600e3).toISOString(), title: 'IT Support Engineer', company: 'PubMatic', location: 'Seattle, WA', workType: 'onsite', externalUrl: 'https://jobs.lever.co/pubmatic/1', flags: [], ...o });

afterEach(() => server.resetHandlers());

describe('radar helpers', () => {
  it('collapses the same posting across cities into one row with a count', () => {
    const rows = collapseEvents([ev({ type: 'taken_down', location: 'A' }), ev({ type: 'taken_down', location: 'B' }), ev({ type: 'new' })]);
    expect(rows.map(r => [r.type, r.count])).toEqual([['taken_down', 2], ['new', 1]]);
  });
  it('formats ages', () => {
    expect(ago(new Date(now - 5 * 60e3).toISOString(), now)).toBe('5m ago');
    expect(ago(new Date(now - 3 * 3600e3).toISOString(), now)).toBe('3h ago');
    expect(ago(new Date(now - 3 * 86400e3).toISOString(), now)).toBe('3d ago');
  });
});

describe('MarketRadar', () => {
  it('shows counters and real events with their requirements', async () => {
    server.use(http.get('*/api/platform/radar', () => HttpResponse.json({
      scope: 'market', live: 105867, openedThisWeek: 27361, takenDownThisWeek: 14202, medianLifetimeDays: 12,
      lastBoardRead: new Date(now - 4 * 60e3).toISOString(), nextBoardRead: new Date(now + 18 * 60e3).toISOString(),
      events: [
        ev({ flags: ['no sponsorship', '5+ yrs'] }),
        ev({ type: 'taken_down', title: 'Sr Help Desk', company: 'C3EL', externalUrl: null }),
        ev({ type: 'reposted', title: 'IT Support Specialist', company: 'Rocket Lab' }),
      ],
    })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MarketRadar onStart={() => {}} /></QueryClientProvider>);
    const radar = await screen.findByTestId('market-radar');
    expect(await within(radar).findByText('105,867')).toBeInTheDocument();
    expect(within(radar).getByText('12d')).toBeInTheDocument();
    expect(within(radar).getByText('last sweep 4m ago · next in 18 min')).toBeInTheDocument();
    expect(within(radar).getByText('Opened')).toBeInTheDocument();
    expect(within(radar).getByText('no sponsorship')).toBeInTheDocument();
    expect(within(radar).getByText('Taken down')).toBeInTheDocument();
    expect(within(radar).getByText('Reposted')).toBeInTheDocument();
    // An opened posting links to the company's page; a taken-down one doesn't (it's gone).
    expect(within(radar).getByText('IT Support Engineer').closest('a')).toHaveAttribute('href', 'https://jobs.lever.co/pubmatic/1');
    expect(within(radar).getByText('Sr Help Desk').closest('a')).toBeNull();
  });
});
