import { render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, it, expect, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { server } from '../mocks/server';
import { MarketRadar, collapseEvents, ago, chartGeometry, type RadarEvent } from '../components/site/market-radar';

const now = Date.now();
const ev = (o: Partial<RadarEvent>): RadarEvent => ({ type: 'new', at: new Date(now - 3 * 3600e3).toISOString(), title: 'IT Support Engineer', company: 'PubMatic', location: 'Seattle, WA', workType: 'onsite', externalUrl: 'https://jobs.lever.co/pubmatic/1', flags: [], ...o });
const series = Array.from({ length: 48 }, (_, i) => ({ t: new Date(now - (47 - i) * 3600e3).toISOString(), opened: i % 4 === 0 ? 10 : 0, closed: i % 6 === 0 ? 4 : 0, live: 1000 + i * 2 }));

afterEach(() => server.resetHandlers());

describe('index helpers', () => {
  it('collapses the same posting across cities into one row with a count', () => {
    const rows = collapseEvents([ev({ type: 'taken_down', location: 'A' }), ev({ type: 'taken_down', location: 'B' }), ev({ type: 'new' })]);
    expect(rows.map(r => [r.type, r.count])).toEqual([['taken_down', 2], ['new', 1]]);
  });
  it('formats ages', () => {
    expect(ago(new Date(now - 5 * 60e3).toISOString(), now)).toBe('5m ago');
    expect(ago(new Date(now - 3 * 86400e3).toISOString(), now)).toBe('3d ago');
  });
  it('draws the line inside the chart and puts opened bars above, closed below the volume axis', () => {
    const g = chartGeometry(series)!;
    expect(g.line.startsWith('M0.0,')).toBe(true);
    expect(g.hi).toBe(1094);
    expect(g.bars.filter(b => b.kind === 'opened').length).toBe(12);
    expect(g.bars.every(b => (b.kind === 'opened' ? b.y + b.h <= 250.01 : b.y >= 250))).toBe(true);
    expect(chartGeometry(series.slice(0, 1))).toBeNull();
  });
});

describe('MarketRadar', () => {
  it('shows the live index, the 24h change, the ticker and what Recrutas does', async () => {
    server.use(http.get('*/api/platform/radar', () => HttpResponse.json({
      scope: 'market', live: 105913, openedThisWeek: 27361, takenDownThisWeek: 14202, medianLifetimeDays: 12,
      lastBoardRead: new Date(now - 4 * 60e3).toISOString(), nextBoardRead: new Date(now + 18 * 60e3).toISOString(),
      events: [ev({}), ev({ type: 'taken_down', title: 'Sr Help Desk', company: 'C3EL', externalUrl: null })],
      series, openedLast24h: 1192, closedLast24h: 386,
    })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MarketRadar onStart={() => {}} /></QueryClientProvider>);
    const radar = await screen.findByTestId('market-radar');
    expect(await within(radar).findByTestId('index-live')).toHaveTextContent('105,913');
    expect(within(radar).getByText('▲ 1,192 opened')).toBeInTheDocument();
    expect(within(radar).getByText('▼ 386 taken down')).toBeInTheDocument();
    expect(within(radar).getByText('last sweep 4m ago · next in 18 min')).toBeInTheDocument();
    expect(within(radar).getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('Live jobs over the last 7 days'));
    expect(within(radar).getAllByText('PubMatic').length).toBeGreaterThan(0);
    expect(within(radar).getByText('A job closes')).toBeInTheDocument();
  });
});
