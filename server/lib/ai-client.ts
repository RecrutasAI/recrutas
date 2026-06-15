import Groq from 'groq-sdk';
import { throttledGroqRequest, type GroqPriority } from './groq-limiter';

export type { GroqPriority };

export interface CallAIOptions {
  priority?: GroqPriority;
  estimatedTokens?: number;
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * Unified generative-AI client with provider failover.
 *
 * Provider is selected by AI_PROVIDER (read at call time, like EMBED_PROVIDER):
 *   - gemini (default): Google `gemini-2.0-flash`. Metered — free tier caps
 *     requests/day (429 when exhausted). Supports text + image + PDF.
 *   - groq: open-weights `llama-3.3-70b-versatile` on Groq's free tier, rate-
 *     limited via groq-limiter. Text only.
 *   - openrouter: OpenAI-compatible gateway over open-weights models (Llama 3.x/4,
 *     Qwen, DeepSeek, Gemma…). Text + image (vision); PDF via multimodal file part.
 *     Avoids single-vendor lock-in — switch models or BYOK without code changes.
 *
 * The configured provider is tried first; on failure we fall through to any OTHER
 * provider that has a key AND supports the modality (so a single-vendor quota trap
 * — the Gemini 429 / HF 402 problem — degrades to another open model instead of
 * dying). Image/PDF skip Groq (text-only). Returns the raw text/JSON string.
 */
type Provider = 'gemini' | 'groq' | 'openrouter';
type Modality = 'text' | 'image' | 'pdf';

// Which providers can serve each modality.
const CAPABLE: Record<Modality, Provider[]> = {
  text: ['gemini', 'groq', 'openrouter'],
  image: ['gemini', 'openrouter'],
  pdf: ['gemini', 'openrouter'],
};

function configuredProvider(): Provider {
  const p = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  return p === 'openrouter' ? 'openrouter' : p === 'groq' ? 'groq' : 'gemini';
}

function getGroqClient(): Groq | null {
  const apiKey = process.env.GROQ_API_KEY || process.env.GROQ_KEY;
  if (!apiKey || apiKey === '%GROQ_API_KEY%') return null;
  return new Groq({ apiKey });
}

function providerHasKey(p: Provider): boolean {
  switch (p) {
    case 'gemini': return !!process.env.GEMINI_API_KEY;
    case 'groq': return !!getGroqClient();
    case 'openrouter': return !!process.env.OPENROUTER_API_KEY;
  }
}

// Ordered, de-duplicated list of providers to try for a modality: the configured
// one first, then the rest — filtered to those that are capable AND have a key.
function providerChain(modality: Modality): Provider[] {
  const capable = CAPABLE[modality];
  const ordered = [configuredProvider(), ...capable].filter(
    (p, i, arr) => capable.includes(p) && arr.indexOf(p) === i,
  );
  return ordered.filter(providerHasKey);
}

// Run an attempt across the provider chain, falling back on failure.
async function withFallback(
  modality: Modality,
  attempt: (p: Provider) => Promise<string>,
): Promise<string> {
  const chain = providerChain(modality);
  if (chain.length === 0) {
    throw new Error(
      `No AI provider available for ${modality}: set AI_PROVIDER and the matching key ` +
      `(GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY)`,
    );
  }
  const errors: string[] = [];
  for (const p of chain) {
    try {
      return await attempt(p);
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`${p}: ${msg}`);
      console.warn(`[AIClient] ${modality} via ${p} failed (${msg})${chain.indexOf(p) < chain.length - 1 ? ' — trying next provider' : ''}`);
    }
  }
  throw new Error(`All AI providers failed for ${modality} — ${errors.join(' | ')}`);
}

// ── Gemini ──────────────────────────────────────────────────────────────────
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

async function geminiRequest(parts: unknown[], systemPrompt: string, opts: CallAIOptions, timeoutMs: number): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: opts.temperature ?? 0.1,
      ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    },
  };
  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
  }
  type GeminiResponse = { candidates?: Array<{ content: { parts: Array<{ text: string }> } }> };
  const data = await res.json() as GeminiResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content');
  return text;
}

const callGeminiText = (system: string, user: string, opts: CallAIOptions) =>
  geminiRequest([{ text: user }], system, opts, 15_000);

const callGeminiImage = (system: string, user: string, imageBase64: string, mimeType: string, opts: CallAIOptions) =>
  geminiRequest([{ inlineData: { mimeType, data: imageBase64 } }, { text: user }], system, opts, 30_000);

const callGeminiPDF = (system: string, user: string, pdfBuffer: Buffer, opts: CallAIOptions) =>
  geminiRequest([{ inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } }, { text: user }], system, opts, 45_000);

// ── Groq (text only) ──────────────────────────────────────────────────────────
async function callGroqText(systemPrompt: string, userPrompt: string, opts: CallAIOptions): Promise<string> {
  const groqClient = getGroqClient();
  if (!groqClient) throw new Error('GROQ_API_KEY not set');
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const completion = await throttledGroqRequest(
    () => groqClient.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: opts.temperature ?? 0.1,
      ...(opts.maxOutputTokens ? { max_tokens: opts.maxOutputTokens } : {}),
    }),
    opts.priority ?? 'medium',
    opts.estimatedTokens ?? 1000,
  );
  const text = completion.choices[0]?.message?.content;
  if (!text) throw new Error('Groq returned no content');
  return text;
}

// ── OpenRouter (OpenAI-compatible; open-weights text + vision + PDF) ────────────
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Defaults are open-weights models; override per-deployment. Verify/adjust slugs
// at https://openrouter.ai/models (append ":free" for the rate-limited free tier).
const OPENROUTER_TEXT_MODEL = () => process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct';
const OPENROUTER_VISION_MODEL = () => process.env.OPENROUTER_VISION_MODEL || 'meta-llama/llama-4-scout';

// Some open models wrap JSON in ```json fences despite response_format; strip them
// so callers can JSON.parse the result directly (Gemini/Groq already return clean).
function stripJsonFence(s: string): string {
  const t = s.trim();
  if (t.startsWith('```')) {
    return t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  return t;
}

async function openRouterRequest(
  model: string,
  messages: unknown[],
  opts: CallAIOptions,
  timeoutMs: number,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Optional attribution headers recommended by OpenRouter.
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://recrutas.ai',
      'X-Title': 'Recrutas',
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      temperature: opts.temperature ?? 0.1,
      ...(opts.maxOutputTokens ? { max_tokens: opts.maxOutputTokens } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${errText.slice(0, 200)}`);
  }
  type ORResponse = { choices?: Array<{ message?: { content?: string } }> };
  const data = await res.json() as ORResponse;
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenRouter returned no content');
  return stripJsonFence(text);
}

const callOpenRouterText = (system: string, user: string, opts: CallAIOptions) =>
  openRouterRequest(OPENROUTER_TEXT_MODEL(), [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], opts, 20_000);

const callOpenRouterImage = (system: string, user: string, imageBase64: string, mimeType: string, opts: CallAIOptions) =>
  openRouterRequest(OPENROUTER_VISION_MODEL(), [
    { role: 'system', content: system },
    { role: 'user', content: [
      { type: 'text', text: user },
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
    ] },
  ], opts, 30_000);

const callOpenRouterPDF = (system: string, user: string, pdfBuffer: Buffer, opts: CallAIOptions) =>
  openRouterRequest(OPENROUTER_VISION_MODEL(), [
    { role: 'system', content: system },
    { role: 'user', content: [
      { type: 'text', text: user },
      { type: 'file', file: { filename: 'resume.pdf', file_data: `data:application/pdf;base64,${pdfBuffer.toString('base64')}` } },
    ] },
  ], opts, 45_000);

// ── Public API (provider-aware, with failover) ─────────────────────────────────

/** Text → JSON string. Tries the configured provider, falls back to the others. */
export async function callAI(systemPrompt: string, userPrompt: string, opts: CallAIOptions = {}): Promise<string> {
  return withFallback('text', (p) => {
    switch (p) {
      case 'gemini': return callGeminiText(systemPrompt, userPrompt, opts);
      case 'groq': return callGroqText(systemPrompt, userPrompt, opts);
      case 'openrouter': return callOpenRouterText(systemPrompt, userPrompt, opts);
    }
  });
}

/** Image (screenshot) + text → JSON string. Vision-capable providers only. */
export async function callAIWithImage(
  systemPrompt: string,
  userPrompt: string,
  imageBase64: string,
  mimeType: 'image/png' | 'image/jpeg' = 'image/jpeg',
  opts: CallAIOptions = {},
): Promise<string> {
  return withFallback('image', (p) => {
    switch (p) {
      case 'gemini': return callGeminiImage(systemPrompt, userPrompt, imageBase64, mimeType, opts);
      case 'openrouter': return callOpenRouterImage(systemPrompt, userPrompt, imageBase64, mimeType, opts);
      default: throw new Error(`${p} does not support image input`);
    }
  });
}

/** PDF buffer + text → JSON string. Multimodal providers only. */
export async function callAIWithPDF(
  systemPrompt: string,
  userPrompt: string,
  pdfBuffer: Buffer,
  opts: CallAIOptions = {},
): Promise<string> {
  return withFallback('pdf', (p) => {
    switch (p) {
      case 'gemini': return callGeminiPDF(systemPrompt, userPrompt, pdfBuffer, opts);
      case 'openrouter': return callOpenRouterPDF(systemPrompt, userPrompt, pdfBuffer, opts);
      default: throw new Error(`${p} does not support PDF input`);
    }
  });
}

/** @deprecated Use callAIWithImage — kept for back-compat; now provider-aware. */
export const callGeminiWithImage = callAIWithImage;
/** @deprecated Use callAIWithPDF — kept for back-compat; now provider-aware. */
export const callGeminiWithPDF = callAIWithPDF;

/** Returns true if at least one provider can serve the modality (default text). */
export function isAIAvailable(modality: Modality = 'text'): boolean {
  return providerChain(modality).length > 0;
}
