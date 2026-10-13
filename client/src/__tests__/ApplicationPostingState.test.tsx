/**
 * Application cards say what happened to the posting since the candidate
 * applied: still posted, taken down, or reposted. Recrutas re-reads every
 * employer's careers page (every few hours to 3 days), so this answers the silence after applying.
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
      app(1, { postingState: 'live', lastCheckedAt: new Date(Date.now() - 5 * 3600_000).toISOString() }),
      app(2, { postingState: 'taken_down', takenDownAt: new Date(Date.now() - 2 * 864e5).toISOString() }),
      app(3, { postingState: 'taken_down' }, { reposted: true }),
    ]);
    expect(await screen.findByTestId('posting-live')).toHaveTextContent("Still posted on Rocket Lab's careers page");
    expect(screen.getByTestId('posting-live')).toHaveTextContent('Checked about 5 hours ago.');  // the real time, never "daily"
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
      applications: 4, enoughData: true, answers: { replied: 0, takenDown: 0, reposted: 0, waiting: 4, waitingPastFollowUp: 2 },
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
  it('shows the totals with how many are waiting', async () => {
    server.use(http.get('*/api/candidate/application-diagnosis', () => HttpResponse.json({
      applications: 1, enoughData: false, answers: { replied: 0, takenDown: 0, reposted: 0, waiting: 4, waitingPastFollowUp: 2 },
      findings: [], nextStep: { kind: 'apply_more', text: 'Apply to a few more.' },
    })));
    renderWith([app(9, { title: 'Help Desk', company: 'PubMatic', location: 'Seattle, WA' }, { appliedAt: new Date().toISOString() })]);
    await screen.findByText(/4 waiting/);
    expect(screen.getByTestId('applications-totals')).toHaveTextContent('1 application · 4 waiting (2 past follow-up)');
    expect(screen.queryByTestId('weekly-summary')).toBeNull();
  });
});

describe('did you hear back', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString();

  it('asks a week after applying and records the answer', async () => {
    let sent: unknown = null;
    server.use(http.put('*/api/candidate/application/:id/status', async ({ request }) => {
      sent = await request.json();
      return HttpResponse.json({});
    }));
    renderWith([app(6, {}, { appliedAt: daysAgo(9), lastStatusUpdate: daysAgo(9) })]);
    const ask = await screen.findByTestId('hear-back');
    expect(ask).toHaveTextContent('Applied 9 days ago. Did you hear back?');
    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
    await vi.waitFor(() => expect(sent).toEqual({ status: 'submitted', source: 'hear_back_prompt' }));
  });

  it('waits a week, and asks only while there is no news', async () => {
    renderWith([
      app(7, {}, { appliedAt: daysAgo(3), lastStatusUpdate: daysAgo(3) }),
      app(8, {}, { status: 'interview_scheduled', appliedAt: daysAgo(20), lastStatusUpdate: daysAgo(20) }),
      app(9, {}, { appliedAt: daysAgo(20), lastStatusUpdate: daysAgo(2) }),                 // answered "not yet" 2 days ago
    ]);
    await screen.findByText('Role 7');
    expect(screen.queryByTestId('hear-back')).toBeNull();
  });
});
