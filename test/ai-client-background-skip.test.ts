/**
 * Bulk background AI work (scraper extraction) must not spend the free Groq or
 * Gemini quotas: both are reserved for résumé parsing, and Gemini is the only
 * reader for scanned PDFs. With only those keys set, background callers see no
 * provider and skip.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { hasAIProvider } from '../server/lib/ai-client';

const BACKGROUND = { skipGroq: true, skipGemini: true };

afterEach(() => vi.unstubAllEnvs());

describe('hasAIProvider for background work', () => {
  it('finds none when only the free Groq and Gemini keys are set', () => {
    vi.stubEnv('GROQ_API_KEY', 'gsk_test');
    vi.stubEnv('GEMINI_API_KEY', 'gem_test');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(hasAIProvider('text', BACKGROUND)).toBe(false);
    // Résumé parsing, which sets neither flag, still has both.
    expect(hasAIProvider('text')).toBe(true);
  });

  it('allows a provider that is not reserved', () => {
    vi.stubEnv('GROQ_API_KEY', 'gsk_test');
    vi.stubEnv('GEMINI_API_KEY', 'gem_test');
    vi.stubEnv('OPENROUTER_API_KEY', 'or_test');
    expect(hasAIProvider('text', BACKGROUND)).toBe(true);
  });
});
