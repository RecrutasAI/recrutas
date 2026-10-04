/**
 * Application cards say what happened to the posting since the candidate
 * applied: still posted, taken down, or reposted. Recrutas re-reads every
 * employer's careers page daily, so this answers the silence after applying.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from '../mocks/server';
import { queryClient } from '@/lib/queryClient';
import ApplicationTracker from '../components/application-tracker';

vi.mock('wouter', async (importOriginal) => ({ ...(await importOriginal<typeof import('wouter')>()), useLocation: () => ['/', vi.fn()] }));

const app = (id: number, job: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, status: 'submitted', appliedAt: '2026-09-20T12:00:00Z', lastStatusUpdate: '2026-09-20T12:00:00Z',
  job: { id: id * 10, title: `Role ${id}`, company: 'Rocket Lab', location: 'Long Beach, CA', workType: 'onsite', externalUrl: 'https://jobs.lever.co/x/y', ...job },
  ...extra,
});

function renderWith(apps: unknown[]) {
  server.use(http.get('*/api/candidate/applications', () => HttpResponse.json(apps)));
  return render(<QueryClientProvider client={queryClient}><ApplicationTracker /></QueryClientProvider>);
}

afterEach(() => { cleanup(); queryClient.clear(); server.resetHandlers(); });

describe('application posting state', () => {
  it('shows live, taken down and reposted postings', async () => {
    renderWith([
      app(1, { postingState: 'live' }),
      app(2, { postingState: 'taken_down', takenDownAt: new Date(Date.now() - 2 * 864e5).toISOString() }),
      app(3, { postingState: 'taken_down' }, { reposted: true }),
    ]);
    expect(await screen.findByTestId('posting-live')).toHaveTextContent("Still posted on Rocket Lab's careers page");
    expect(screen.getByTestId('posting-taken-down')).toHaveTextContent(/Taken down 2 days ago/);
    expect(screen.getByTestId('posting-reposted')).toHaveTextContent('posted the same role again');
  });

  it('says nothing when the posting state is unknown', async () => {
    renderWith([app(4, { postingState: 'unknown' })]);
    await screen.findByText('Role 4');
    expect(screen.queryByTestId('posting-live')).toBeNull();
    expect(screen.queryByTestId('posting-taken-down')).toBeNull();
  });
});
