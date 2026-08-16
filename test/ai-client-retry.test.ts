/**
 * Guards the failure semantics of the shared AI client.
 *
 * Written after a live incident: `gemini-2.0-flash` had been retired by Google
 * and returned 404 on every call, so the résumé PDF path and all four scraper
 * callers silently degraded to their fallbacks. Nothing distinguished "this
 * model is gone" from "this model is busy", and neither was retried, so a
 * single transient 503 also demoted the whole call.
 *
 * The distinction being locked in here:
 *   - transient (429/5xx) → retry the SAME provider before failing over
 *   - permanent (404/401/403) → fail over immediately, never burn retries
 */

// The suite runs under ESM (NODE_OPTIONS=--experimental-vm-modules), where the
// `jest` global is not injected — it has to be imported explicitly.
import { jest } from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };

/** Queue of canned fetch outcomes, consumed in order. */
type Outcome = { status: number; body?: string };
let queue: Outcome[] = [];
let calls: string[] = [];

function installFetch() {
  calls = [];
  (globalThis as any).fetch = jest.fn(async (url: string) => {
    calls.push(String(url).split('/models/')[1]?.split(':')[0] ?? String(url));
    const next = queue.shift() ?? { status: 500 };
    if (next.status !== 200) {
      return { ok: false, status: next.status, text: async () => next.body ?? 'err' } as any;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: next.body ?? '{"ok":true}' }] } }] }),
    } as any;
  });
}

describe('ai-client failure semantics', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    // Gemini only: an unset Groq/OpenRouter key keeps the provider chain to one
    // entry, so retry behaviour is observable without cross-provider fallover.
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.AI_PROVIDER = 'gemini';
    installFetch();
  });

  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('retries the same provider on a transient 503 and succeeds', async () => {
    queue = [{ status: 503 }, { status: 200, body: '{"parsed":true}' }];
    const { callAI } = await import('../server/lib/ai-client');
    await expect(callAI('sys', 'user')).resolves.toBe('{"parsed":true}');
    expect(calls).toHaveLength(2);
  });

  it('retries on 429 — quota throttling is not a permanent failure', async () => {
    queue = [{ status: 429 }, { status: 429 }, { status: 200, body: '{"ok":1}' }];
    const { callAI } = await import('../server/lib/ai-client');
    await expect(callAI('sys', 'user')).resolves.toBe('{"ok":1}');
    expect(calls).toHaveLength(3);
  });

  it('does NOT retry a 404 — a retired model never recovers', async () => {
    // The exact shape of the incident: Google retires the pinned model.
    queue = [{ status: 404, body: 'This model models/gemini-2.0-flash is no longer available' }];
    const { callAI } = await import('../server/lib/ai-client');
    await expect(callAI('sys', 'user')).rejects.toThrow(/404/);
    expect(calls).toHaveLength(1);
  });

  it('does NOT retry a 401 — a bad key never recovers', async () => {
    queue = [{ status: 401, body: 'API key not valid' }];
    const { callAI } = await import('../server/lib/ai-client');
    await expect(callAI('sys', 'user')).rejects.toThrow(/401/);
    expect(calls).toHaveLength(1);
  });

  it('gives up after the per-modality try budget rather than looping forever', async () => {
    queue = [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }];
    const { callAI } = await import('../server/lib/ai-client');
    await expect(callAI('sys', 'user')).rejects.toThrow(/All AI providers failed/);
    expect(calls).toHaveLength(3); // text modality budget
  });

  it('calls the model pinned by GEMINI_MODEL, not a floating alias', async () => {
    process.env.GEMINI_MODEL = 'gemini-3.5-flash';
    queue = [{ status: 200, body: '{}' }];
    const { callAI } = await import('../server/lib/ai-client');
    await callAI('sys', 'user');
    expect(calls[0]).toBe('gemini-3.5-flash');
    expect(calls[0]).not.toMatch(/latest/);
  });

  it('PDF gets a smaller try budget than text — its attempts are the slowest', async () => {
    queue = [{ status: 503 }, { status: 503 }, { status: 503 }];
    const { callAIWithPDF } = await import('../server/lib/ai-client');
    await expect(callAIWithPDF('sys', 'user', Buffer.from('%PDF-1.4'))).rejects.toThrow(/All AI providers failed/);
    expect(calls).toHaveLength(2);
  });
});
