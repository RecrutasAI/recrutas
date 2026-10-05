/**
 * Application cards say what happened to the posting since the candidate
 * applied: still posted, taken down, or reposted. Recrutas re-reads every
 * employer's careers page daily, so this answers the silence after applying.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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

describe('application diagnosis', () => {
  it('shows findings and one next step', async () => {
    server.use(http.get('*/api/candidate/application-diagnosis', () => HttpResponse.json({
      applications: 4, enoughData: true,
      findings: ['None of your 4 applications has had a reply yet.', '2 are still posted with no reply after 14+ days.'],
      nextStep: { kind: 'follow_up', text: 'Follow up: 2 applications are past 14 days with the job still posted.' },
    })));
    renderWith([app(5, { postingState: 'live' })]);
    const why = await screen.findByTestId('application-diagnosis');
    expect(screen.getByTestId('diagnosis-next-step')).toHaveTextContent('Next step: Follow up');
    // Findings stay folded until asked for.
    expect(why).not.toHaveTextContent('None of your 4 applications has had a reply yet.');
    fireEvent.click(screen.getByRole('button', { name: /Why you're not hearing back/ }));
    expect(why).toHaveTextContent('None of your 4 applications has had a reply yet.');
  });
});

describe('job-search log', () => {
  it('starts folded to one line at the bottom', async () => {
    localStorage.clear();
    renderWith([app(8, { title: 'Help Desk', company: 'PubMatic', location: 'Seattle, WA' }, { appliedAt: new Date().toISOString() })]);
    const log = await screen.findByTestId('job-search-log');
    expect(log).toHaveTextContent('Filling a weekly claim?');
    expect(screen.queryByTestId('job-search-log-status')).toBeNull();
  });

  it('lists this week\'s applications against the weekly minimum', async () => {
    localStorage.clear();
    const recent = new Date().toISOString();
    renderWith([
      app(6, { title: 'Help Desk', company: 'PubMatic', location: 'Seattle, WA' }, { appliedAt: recent }),
      app(7, { title: 'Support Engineer', company: 'Acme', location: 'Remote' }, { appliedAt: recent }),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: /Job-search log for unemployment/ }));
    const log = await screen.findByTestId('job-search-log');
    expect(localStorage.getItem('recrutas_job_search_log_open')).toBe('1');
    expect(screen.getByTestId('job-search-log-status')).toHaveTextContent('2 of 3 employer contacts this week');
    expect(log).toHaveTextContent('Seattle, WA');
    expect(log).toHaveTextContent('Online · Application/resume');
  });
});

describe('applications overview', () => {
  it('puts the totals and the week on one line, with what happened below', async () => {
    server.use(http.get('*/api/candidate/weekly-summary', () => HttpResponse.json({
      appliedThisWeek: [{ title: 'Help Desk', company: 'PubMatic' }], updates: [{ kind: 'taken_down', title: 'IT Support', company: 'Acme' }],
      waiting: 4, waitingPastFollowUp: 2, newApplyMatches: 12, topMatches: [], nextStep: null,
    })));
    renderWith([app(9, { title: 'Help Desk', company: 'PubMatic', location: 'Seattle, WA' }, { appliedAt: new Date().toISOString() })]);
    expect(await screen.findByTestId('weekly-summary')).toHaveTextContent('This week: 1 applied · 12 new jobs you qualify for');
    expect(screen.getByTestId('applications-totals')).toHaveTextContent('1 application · 4 waiting (2 past follow-up)');
    expect(screen.getByTestId('weekly-updates')).toHaveTextContent('Taken down: IT Support at Acme');
  });
});
