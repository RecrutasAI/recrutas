/**
 * The real Turnstile handle, against a fake Cloudflare global: getToken hands
 * back a token already issued, waits for one still being issued, and resolves
 * null when the check errors — so a form never hangs on a failed check.
 */
import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef } from 'react';

type Opts = { callback: (t: string) => void; 'error-callback': () => void };
let opts: Opts;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site-key');
  window.turnstile = {
    render: (_el, o) => { opts = o as unknown as Opts; return 'w1'; },
    reset: vi.fn(),
    remove: vi.fn(),
  };
});

async function mount() {
  const { Turnstile } = await import('@/components/turnstile');
  const ref = createRef<import('@/components/turnstile').TurnstileHandle>();
  render(<Turnstile ref={ref} />);
  await waitFor(() => expect(opts).toBeDefined());
  return ref;
}

describe('Turnstile getToken', () => {
  it('waits for a token still being issued', async () => {
    const ref = await mount();
    const pending = ref.current!.getToken();
    opts.callback('tok-late');
    await expect(pending).resolves.toBe('tok-late');
  });

  it('returns a token already issued, and none after reset', async () => {
    const ref = await mount();
    opts.callback('tok-now');
    await expect(ref.current!.getToken()).resolves.toBe('tok-now');

    ref.current!.reset();
    const next = ref.current!.getToken();
    opts.callback('tok-fresh');
    await expect(next).resolves.toBe('tok-fresh');
  });

  it('resolves null when the check errors', async () => {
    const ref = await mount();
    const pending = ref.current!.getToken();
    opts['error-callback']();
    await expect(pending).resolves.toBeNull();
  });
});
