import { PostHog } from 'posthog-node';

const KEY = process.env.POSTHOG_KEY;
const HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const SEND_TIMEOUT_MS = 1500;

let client: PostHog | null = null;

if (KEY) {
  client = new PostHog(KEY, { host: HOST, flushAt: 20, flushInterval: 10000 });
}

/**
 * Sends the event now and resolves when PostHog has it (or after 1.5 s; never rejects).
 *
 * Await it in request handlers. The API runs on Vercel, which freezes the function once the
 * response is sent, so the batched capture() lost events it hadn't flushed yet: 3 of 8 real
 * sign-ups in Sep-Oct 2026 had no signup_completed, which hid them from the activation funnel.
 */
export async function track(distinctId: string, event: string, properties?: Record<string, any>): Promise<void> {
  if (!client || !distinctId) {return;}
  try {
    await Promise.race([
      client.captureImmediate({ distinctId, event, properties }),
      new Promise(resolve => setTimeout(resolve, SEND_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.warn('[analytics] capture failed:', (err as Error).message);
  }
}

export async function shutdown() {
  if (!client) return;
  try {
    await client.shutdown();
  } catch {
    // best-effort
  }
}
