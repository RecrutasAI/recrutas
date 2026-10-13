import { sql } from 'drizzle-orm/sql';
import { db } from '../db';

/**
 * Daily caps for emails we can do without, so sign-in emails always get through.
 *
 * Resend's free plan sends 100 emails a day (3,000 a month), and Supabase's sign-up
 * confirmations and password resets go out through the same account. So an email sign-up costs
 * only its confirmation: the welcome email is off unless WELCOME_EMAIL=on, and waitlist entries no
 * longer email hello@. What's left optional (welcome when on, the waitlist confirmation) stops at
 * a daily cap; the account or waitlist entry is still saved.
 *
 * Counted from rows already in the database (today, UTC; both columns are UTC timestamps
 * without a zone), so it holds across serverless
 * instances. If the count can't be read, the email is skipped.
 */
const CAPS = {
  welcome: () => Number(process.env.WELCOME_EMAIL_DAILY_MAX ?? 15),
  waitlist: () => Number(process.env.WAITLIST_EMAIL_DAILY_MAX ?? 15),
};

export async function underDailyCap(kind: keyof typeof CAPS, conn: { execute: typeof db.execute } = db): Promise<boolean> {
  try {
    const q = kind === 'welcome'
      ? sql`SELECT count(*)::int AS n FROM users WHERE "createdAt" >= date_trunc('day', now() AT TIME ZONE 'UTC')`
      : sql`SELECT count(*)::int AS n FROM waitlist_entries WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`;
    const r: any = await conn.execute(q);
    const n = Number((r?.rows ?? r)?.[0]?.n ?? Infinity);
    return n <= CAPS[kind]();  // today's rows include the one just saved
  } catch (err) {
    console.warn(`[email-budget] ${kind} count failed, skipping the email:`, (err as Error).message);
    return false;
  }
}
