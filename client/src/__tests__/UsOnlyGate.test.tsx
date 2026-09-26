/**
 * Recrutas lists US jobs only (user, 2026-09-26). Most genuine signups in
 * Aug–Sep were outside the US and got a feed they could never use; the gate
 * tells them before they create an account, without hard-blocking US job
 * seekers who are travelling or on a VPN.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
import { UsOnlyGate } from '../components/us-only-gate';

function mockGeo(country: string | null, extra?: (url: string, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const r = extra?.(url, init);
    if (r) {return r;}
    return new Response(JSON.stringify({ country }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const renderGate = () => render(<UsOnlyGate><div>SIGNUP FORM</div></UsOnlyGate>);

beforeEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('UsOnlyGate', () => {
  it('shows the signup form to US visitors', async () => {
    mockGeo('US');
    renderGate();
    await waitFor(() => expect(screen.getByText('SIGNUP FORM')).toBeInTheDocument());
    expect(screen.queryByTestId('us-only-gate')).not.toBeInTheDocument();
  });

  it('shows the form when the country is unknown (local dev, lookup failure)', async () => {
    mockGeo(null);
    renderGate();
    await waitFor(() => expect(screen.getByText('SIGNUP FORM')).toBeInTheDocument());
  });

  it('tells non-US visitors before they sign up, naming their country', async () => {
    mockGeo('NO');
    renderGate();
    expect(await screen.findByText(/US jobs only/)).toBeInTheDocument();
    expect(screen.getByText(/visiting from Norway/)).toBeInTheDocument();
    expect(screen.queryByText('SIGNUP FORM')).not.toBeInTheDocument();
  });

  it('lets a US job seeker abroad continue to the form', async () => {
    mockGeo('BR');
    renderGate();
    await userEvent.click(await screen.findByRole('button', { name: /looking for jobs in the US/ }));
    expect(screen.getByText('SIGNUP FORM')).toBeInTheDocument();
    expect(sessionStorage.getItem('recrutas_us_gate_dismissed')).toBe('1');
  });

  it('records a notify-me request tagged with the country', async () => {
    const fetchMock = mockGeo('IN', (url) => url === '/api/waitlist' ? new Response('{"ok":true}', { status: 200 }) : undefined);
    renderGate();
    await userEvent.type(await screen.findByLabelText(/email when we expand/), 'lavan@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Notify me' }));
    expect(await screen.findByText(/we'll email you when Recrutas covers India/)).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([u]) => u === '/api/waitlist')!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ email: 'lavan@example.com', source: 'non-us:IN' });
  });
});
