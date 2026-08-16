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
 *   - gemini (default): Google, model pinned by GEMINI_MODEL (see below).
 *     Metered — free tier caps requests/day (429 when exhausted). A retired
 *     model returns 404, which is NOT a quota error and never recovers on its
 *     own. Supports text + image + PDF.
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

// An HTTP-shaped provider failure. `status` is what separates "this model is
// busy" (retry) from "this model is gone" (fail over) — a distinction the
// message text alone does not reliably carry.
type ApiError = Error & { status?: number };
function apiError(message: string, status: number): ApiError {
  return Object.assign(new Error(message), { status });
}

// 429 = rate limited, 5xx = provider-side. All recover on their own; a retired
// model (404) or a bad key (401/403) never does, so those fail over immediately.
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_BASE_MS = 600;
// Tries per provider, bounded by what the caller's own budget can absorb.
// PDF gets 2 because its attempts are the slowest and the résumé parser caps
// the entire operation at 60s; text is cheap enough to afford 3.
const TRIES_BY_MODALITY: Record<Modality, number> = { text: 3, image: 2, pdf: 2 };

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
  const maxTries = TRIES_BY_MODALITY[modality];
  for (const p of chain) {
    for (let tryN = 1; tryN <= maxTries; tryN++) {
      try {
        return await attempt(p);
      } catch (err) {
        const msg = (err as Error).message;
        const status = (err as ApiError).status;
        // Retry the SAME provider on transient failures before moving on: a 503
        // is the model being busy, not the model being wrong, and giving up on
        // the first one silently demotes the whole call to a weaker fallback.
        // Measured on the free tier, PDF calls 503 on roughly half of attempts.
        const transient = status !== undefined && TRANSIENT_STATUS.has(status);
        if (transient && tryN < maxTries) {
          const backoffMs = RETRY_BASE_MS * 2 ** (tryN - 1) + Math.random() * RETRY_BASE_MS;
          console.warn(`[AIClient] ${modality} via ${p} transient ${status} (try ${tryN}/${maxTries}) — retrying in ${Math.round(backoffMs)}ms`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        errors.push(`${p}: ${msg}`);
        console.warn(`[AIClient] ${modality} via ${p} failed (${msg})${chain.indexOf(p) < chain.length - 1 ? ' — trying next provider' : ''}`);
        break;
      }
    }
  }
  throw new Error(`All AI providers failed for ${modality} — ${errors.join(' | ')}`);
}

// ── Gemini ──────────────────────────────────────────────────────────────────
// Pin an explicit version, never a floating `-latest` alias: this model parses
// résumés and scraped job pages into fixed JSON shapes, and a silent model swap
// under us changes extraction behaviour with no deploy and no signal.
// gemini-2.0-flash was retired by Google and returned 404 on EVERY call — the
// PDF résumé path and all four scraper callers had been failing over to their
// fallbacks unnoticed. Override with GEMINI_MODEL when this one is retired too.
//
// ⚠️ ListModels is NOT authoritative for what a given key may call: it happily
// lists gemini-2.5-flash, which 404s for this project with "no longer available
// to NEW users". Probe a candidate with a real generateContent call before
// pinning it. Verified callable on this key: gemini-3.5-flash / -3.6-flash /
// gemini-flash-latest; 3.7-flash returns 503 under load.
// Read at CALL time, not module load — same convention as AI_PROVIDER and
// EMBED_PROVIDER. Resolving once at import made GEMINI_MODEL unusable as an
// operational lever: swapping the model would have needed a redeploy, which is
// precisely the slow path you do NOT want when Google retires a model under you.
const geminiModel = () => process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const geminiUrl = () =>
  `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent`;

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
  const res = await fetch(`${geminiUrl()}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw apiError(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`, res.status);
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

// 20s, not 45s: the résumé path that calls this caps the WHOLE parse at 60s, so
// a 45s attempt left no room for a second try or for the text+Groq fallback
// behind it. Two 20s tries plus backoff still fits inside the caller's budget.
const callGeminiPDF = (system: string, user: string, pdfBuffer: Buffer, opts: CallAIOptions) =>
  geminiRequest([{ inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } }, { text: user }], system, opts, 20_000);

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
    throw apiError(`OpenRouter API error ${res.status}: ${errText.slice(0, 200)}`, res.status);
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
