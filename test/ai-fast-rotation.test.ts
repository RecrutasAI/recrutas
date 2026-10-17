/**
 * The extension's form fill waits on the AI while a person watches the button. On 2026-10-17 a
 * 5-field fill took 15.3 s and came back mostly empty: the shared client retried a busy Gemini
 * (503 "high demand") with backoff until the route's 15 s limit, and never tried Groq, which
 * answered in 0.2-0.4 s. raceProvidersInOrder gives each provider one try, fastest first, inside
 * one budget, so a slow or failing provider costs at most its own cap.
 */
import { describe, it, expect } from 'vitest';
import { raceProvidersInOrder, FAST_TEXT_ORDER } from '../server/lib/ai-client';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('raceProvidersInOrder', () => {
  it('tries the fastest free provider first', () => {
    expect(FAST_TEXT_ORDER[0]).toBe('groq');
    expect(FAST_TEXT_ORDER).toEqual(['groq', 'cloudflare', 'gemini']);
  });

  it('returns the first provider that answers, without trying the rest', async () => {
    const tried: string[] = [];
    const r = await raceProvidersInOrder(['a', 'b'], async p => { tried.push(p); return '{"ok":true}'; }, 5_000);
    expect(r).toEqual({ text: '{"ok":true}', provider: 'a' });
    expect(tried).toEqual(['a']);
  });

  it('fails over at once when a provider errors (a 429 or 503), with no retries', async () => {
    const tried: string[] = [];
    const r = await raceProvidersInOrder(['a', 'b', 'c'], async p => {
      tried.push(p);
      if (p !== 'c') {throw new Error(`${p} 503`);}
      return '{}';
    }, 5_000);
    expect(r.provider).toBe('c');
    expect(tried).toEqual(['a', 'b', 'c']);
  });

  it('treats an empty answer as a failure', async () => {
    const r = await raceProvidersInOrder(['a', 'b'], async p => (p === 'a' ? '  ' : 'x'), 5_000);
    expect(r.provider).toBe('b');
  });

  it('cuts a slow provider off at its cap so the next one still has time', async () => {
    const started = Date.now();
    const r = await raceProvidersInOrder(['slow', 'fast'], async p => {
      if (p === 'slow') {await wait(5_000);}
      return 'answer';
    }, 4_000, { slow: 200 });
    expect(r.provider).toBe('fast');
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('never runs past the budget, and says what each provider did', async () => {
    const started = Date.now();
    await expect(raceProvidersInOrder(['a', 'b'], async () => { await wait(5_000); return 'late'; }, 1_300))
      .rejects.toThrow(/a: timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
