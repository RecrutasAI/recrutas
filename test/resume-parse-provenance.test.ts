/**
 * Guards résumé-parse observability.
 *
 * The incident this comes from: `gemini-2.0-flash` was retired by Google and
 * returned 404 on every call. The parser fell through to its fallbacks and kept
 * reporting success, so the outage was invisible until a wrong job title turned
 * up on a profile. Nothing recorded WHICH engine had answered, and the engines
 * are not equivalent — measured on a real 3-page PDF, the multimodal and text
 * LLM paths both got 7/7 positions while the rule engine got 0/7.
 *
 * So the invariant is: every stored parse says who produced it, and a parse
 * that fell back is flagged rather than passing as clean.
 */

import { classifyPrimaryError } from '../server/services/resume.service';

describe('classifyPrimaryError', () => {
  // The distinction that actually matters operationally: a retired model needs
  // a human to change a pinned id, quota/overload clear on their own. Conflating
  // them is what let a dead model hide behind "free tier exhausted again".
  it('separates a retired model from a transient quota failure', () => {
    expect(classifyPrimaryError(
      'Gemini API error 404: This model models/gemini-2.0-flash is no longer available.'
    )).toBe('model_retired');

    expect(classifyPrimaryError(
      'Gemini API error 429: Quota exceeded for quota metric'
    )).toBe('quota');

    expect(classifyPrimaryError(
      'Gemini API error 503: This model is currently experiencing high demand.'
    )).toBe('overloaded');
  });

  it('classifies timeouts and auth failures distinctly', () => {
    expect(classifyPrimaryError('The operation was aborted due to timeout')).toBe('timeout');
    expect(classifyPrimaryError('Gemini API error 401: API key not valid')).toBe('auth');
  });

  it('falls back to "other" rather than guessing', () => {
    expect(classifyPrimaryError('socket hang up')).toBe('other');
  });

  it('is case-insensitive — provider error text is not stable', () => {
    expect(classifyPrimaryError('NO LONGER AVAILABLE')).toBe('model_retired');
    expect(classifyPrimaryError('Rate Limit Exceeded')).toBe('quota');
  });

  it('returns a bounded label set, so PostHog breakdowns stay low-cardinality', () => {
    const allowed = new Set(['model_retired', 'quota', 'overloaded', 'timeout', 'auth', 'other']);
    const samples = [
      'Gemini API error 404: gone', 'Gemini API error 429: quota', 'high demand',
      'aborted due to timeout', 'API key not valid', 'ECONNRESET', '',
    ];
    for (const s of samples) expect(allowed.has(classifyPrimaryError(s))).toBe(true);
  });
});

describe('parse provenance contract', () => {
  it('treats a rules-engine result as degraded, never as a clean parse', async () => {
    // The rule engine is a legitimate last resort for skills but produced 0/7
    // correct positions on a real PDF, so its output must never be recorded
    // with the same standing as an LLM parse.
    const { AIResumeParser } = await import('../server/ai-resume-parser');
    const parser: any = new AIResumeParser();

    // No AI keys → the AI leg cannot win, forcing the rule engine to answer.
    const saved = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GROQ_API_KEY: process.env.GROQ_API_KEY, HF_API_KEY: process.env.HF_API_KEY };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.HF_API_KEY;
    try {
      const res = await parser.parseText(
        'Jane Doe\nSenior Software Engineer\nAcme Corp\nJanuary 2020 - Present\nPython, AWS, Docker',
      );
      expect(res.extractor).toBe('rules');
      expect(res.degraded).toBe(true);
    } finally {
      Object.assign(process.env, saved);
    }
  }, 30000);
});
