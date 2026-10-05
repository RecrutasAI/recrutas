/**
 * Signed unsubscribe links for Recrutas emails. They must work without
 * signing in (from any inbox), so each link carries an HMAC of the user id and
 * the email kind. Emails are sent from the VPS and links are handled on
 * Vercel; both have the Supabase service key, which keys the HMAC unless
 * UNSUBSCRIBE_SECRET is set.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export type EmailKind = 'weekly' | 'updates';
const BASE = 'https://www.recrutas.ai';

function key(): string {
  const k = process.env.UNSUBSCRIBE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) {throw new Error('No key for unsubscribe links');}
  return k;
}

export const unsubscribeSignature = (userId: string, kind: EmailKind): string =>
  createHmac('sha256', key()).update(`unsubscribe:${kind}:${userId}`).digest('base64url');

export const unsubscribeUrl = (userId: string, kind: EmailKind): string =>
  `${BASE}/api/email/unsubscribe?u=${encodeURIComponent(userId)}&k=${kind}&s=${unsubscribeSignature(userId, kind)}`;

export function verifyUnsubscribe(userId: unknown, kind: unknown, sig: unknown): kind is EmailKind {
  if (typeof userId !== 'string' || typeof sig !== 'string' || (kind !== 'weekly' && kind !== 'updates')) {return false;}
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {return false;}
  const expected = Buffer.from(unsubscribeSignature(userId, kind));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Headers for one-click unsubscribe in mail apps (RFC 8058). */
export const unsubscribeHeaders = (userId: string, kind: EmailKind): Record<string, string> => ({
  'List-Unsubscribe': `<${unsubscribeUrl(userId, kind)}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
});
