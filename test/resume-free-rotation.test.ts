/**
 * The free AI rotation for résumé text (2026-10-08): Groq → Gemini Flash-Lite →
 * OpenRouter :free → Cloudflare Workers AI. An error OR an empty answer moves
 * to the next provider; only when all of them fail does the rule engine win.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { groqCreate, callTextWith } = vi.hoisted(() => ({ groqCreate: vi.fn(), callTextWith: vi.fn() }));

vi.mock('groq-sdk', () => ({
  default: class { chat = { completions: { create: groqCreate } }; },
}));
vi.mock('../server/lib/ai-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/lib/ai-client')>()),
  callTextWith,
  textProviderConfigured: () => true,
  isAIAvailable: () => true,
}));

process.env.GROQ_API_KEY = 'test-key';
// Short Groq budget: a 429 makes the limiter hold the call; the rotation must move on.
process.env.PARSE_GROQ_BUDGET_MS = '300';
delete process.env.GROQ_MODEL;
delete process.env.USE_OLLAMA;

async function loadParser() {
  vi.resetModules();
  return (await import('../server/ai-resume-parser')).AIResumeParser;
}

const RESUME = `Jane Doe\njane@example.com\nEXPERIENCE\nSoftware Engineer, Acme Corp, 2019 - 2024\n- Built React and Node.js services\nSKILLS\nReact, Node.js, PostgreSQL`;
const FULL = {
  personalInfo: { name: 'Jane Doe' }, summary: '',
  skills: { technical: ['React', 'Node.js'], soft: [], tools: ['PostgreSQL'] },
  experience: { totalYears: 5, level: 'mid', positions: [{ title: 'Software Engineer', company: 'Acme Corp', duration: '2019 - 2024' }] },
  education: [], certifications: [], projects: [], languages: [],
};
const EMPTY = { ...FULL, skills: { technical: [], soft: [], tools: [] }, experience: { totalYears: 0, level: 'entry', positions: [] } };
const groqSays = (data: unknown) => ({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: 'stop' }] });

beforeEach(() => { groqCreate.mockReset(); callTextWith.mockReset(); });

describe('free AI rotation', () => {
  it('uses Groq when it answers, and asks no one else', async () => {
    groqCreate.mockResolvedValue(groqSays(FULL));
    const r = await new (await loadParser())().parseText(RESUME);
    expect(r.extractor).toBe('ai-text');
    expect((r.aiExtracted as any).aiProvider).toBe('groq');
    expect(callTextWith).not.toHaveBeenCalled();
  });

  it('moves to Gemini Flash-Lite when Groq is rate-limited', async () => {
    groqCreate.mockRejectedValue(Object.assign(new Error('429 Rate limit reached for tokens per day'), { status: 429 }));
    callTextWith.mockResolvedValueOnce(JSON.stringify(FULL));
    const r = await new (await loadParser())().parseText(RESUME);
    expect((r.aiExtracted as any).aiProvider).toBe('gemini-lite');
    expect(callTextWith.mock.calls[0][0]).toBe('gemini');
    expect(callTextWith.mock.calls[0][3].model).toMatch(/flash-lite/);
    expect(r.aiExtracted.experience.positions[0].company).toBe('Acme Corp');
  });

  it('treats an empty answer as a failure and keeps going down the list', async () => {
    groqCreate.mockResolvedValue(groqSays(EMPTY));
    callTextWith
      .mockResolvedValueOnce(JSON.stringify(EMPTY))           // gemini: empty
      .mockRejectedValueOnce(new Error('429 free-models-per-day')) // openrouter: out
      .mockResolvedValueOnce(JSON.stringify(FULL));           // cloudflare: answers
    const r = await new (await loadParser())().parseText(RESUME);
    expect(callTextWith.mock.calls.map(c => c[0])).toEqual(['gemini', 'openrouter', 'cloudflare']);
    expect((r.aiExtracted as any).aiProvider).toBe('cloudflare');
    expect(r.degraded).toBe(false);
  });

  it('falls to the rule engine only when every provider fails, and says why for each', async () => {
    groqCreate.mockRejectedValue(Object.assign(new Error('429 Rate limit'), { status: 429 }));
    callTextWith.mockRejectedValue(new Error('503 overloaded'));
    const r = await new (await loadParser())().parseText(RESUME);
    expect(r.extractor).toBe('rules');
    expect(r.degraded).toBe(true);
    expect(callTextWith).toHaveBeenCalledTimes(3);
  });
});
