/**
 * Daily probe of the AI models the app depends on — fails loudly when one is gone.
 *
 * Why: model retirements have silently broken résumé parsing three times
 * (gemini-2.0-flash; Groq's llama-3.3-70b-versatile; OpenRouter's
 * llama-4-scout). Each failed over to the rule engine without an error
 * anywhere, and was found weeks later by reading a user's garbled profile.
 * This makes the next one an email the morning it happens.
 *
 *   Groq (primary text model): any failure → exit non-zero → cron alert.
 *   Gemini (multimodal backup): 404 (retired) → alert; 429/503 (free-tier
 *   quota, overload) → recorded as a warning, since they recover on their own.
 *
 * Usage: npx tsx scripts/check-ai-models.ts
 */
import { client } from '../server/db.js';
import { groqModel, groqReasoningParams, geminiModel } from '../server/lib/ai-client.js';
import { runAsPipeline, type PipelineSummary } from '../server/services/pipeline-run.service.js';

type Probe = { name: string; ok: boolean; fatal: boolean; detail: string; ms: number };

async function probeGroq(): Promise<Probe> {
  const model = groqModel();
  const name = `groq ${model}`;
  const key = process.env.GROQ_API_KEY;
  if (!key) {return { name, ok: false, fatal: true, detail: 'GROQ_API_KEY not set', ms: 0 };}
  const t = Date.now();
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model, ...groqReasoningParams(model), max_tokens: 200, temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'Return {"ok": true} as JSON.' }],
      }),
    });
    const body = await res.text();
    if (!res.ok) {return { name, ok: false, fatal: res.status !== 429, detail: `HTTP ${res.status}: ${body.slice(0, 200)}`, ms: Date.now() - t };}
    JSON.parse(JSON.parse(body).choices?.[0]?.message?.content ?? '');
    return { name, ok: true, fatal: false, detail: 'ok', ms: Date.now() - t };
  } catch (err: any) {
    return { name, ok: false, fatal: true, detail: err?.message ?? String(err), ms: Date.now() - t };
  }
}

async function probeGemini(): Promise<Probe> {
  const model = geminiModel();
  const name = `gemini ${model}`;
  const key = process.env.GEMINI_API_KEY;
  if (!key) {return { name, ok: false, fatal: false, detail: 'GEMINI_API_KEY not set (backup only)', ms: 0 };}
  const t = Date.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }] }),
      },
    );
    if (res.ok) {return { name, ok: true, fatal: false, detail: 'ok', ms: Date.now() - t };}
    const body = (await res.text()).slice(0, 200);
    // 404 = model retired: never recovers. 429 (20 requests/day on the free
    // tier) and 503 (overloaded) clear on their own.
    return { name, ok: false, fatal: res.status === 404 || res.status === 400 || res.status === 403, detail: `HTTP ${res.status}: ${body}`, ms: Date.now() - t };
  } catch (err: any) {
    return { name, ok: false, fatal: false, detail: err?.message ?? String(err), ms: Date.now() - t };
  }
}

async function main(): Promise<PipelineSummary> {
  const probes = [await probeGroq(), await probeGemini()];
  for (const p of probes) {
    console.log(`${p.ok ? 'OK  ' : p.fatal ? 'FAIL' : 'WARN'} ${p.name} (${p.ms}ms) ${p.ok ? '' : p.detail}`);
  }
  const fatal = probes.filter(p => p.fatal);
  if (fatal.length > 0) {
    // Thrown, not returned: run-cron.sh alerts on a non-zero exit.
    throw new Error(`AI model check failed — ${fatal.map(p => `${p.name}: ${p.detail}`).join(' | ')}. ` +
      'Set GROQ_MODEL / GEMINI_MODEL to a live model (Vercel + VPS .env).');
  }
  const warned = probes.filter(p => !p.ok);
  return {
    status: warned.length > 0 ? 'warning' : 'ok',
    itemsProcessed: probes.filter(p => p.ok).length,
    itemsFailed: warned.length,
    message: probes.map(p => `${p.name}: ${p.ok ? 'ok' : p.detail.slice(0, 80)}`).join('; '),
  };
}

runAsPipeline('check-ai-models', main)
  .then(() => { client?.end(); process.exit(0); })
  .catch((err) => { console.error('[check-ai-models]', err?.message ?? err); client?.end(); process.exit(1); });
