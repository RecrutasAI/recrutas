/**
 * Feed gate: at most `feedGateSlots` fresh feeds are scored at once across every
 * instance (docs/scaling-strategy.md). Scoring is the heaviest thing a visit
 * does; without a cap a spike makes every request score in parallel and all of
 * them slow down together until they time out (measured 2026-10-12: 25 at once,
 * all 25 hit the 45 s limit and got an empty feed). With it, people over the cap
 * get their last feed or a quick fallback right away (storage.getJobRecommendations).
 *
 * Slots are rows in feed_gate_slots (migrations/add-feed-gate-slots.sql), taken
 * with one statement so pgBouncer's transaction pooling is fine. A slot is a
 * lease: one held by an instance that died frees itself after SLOT_LEASE_MS.
 *
 * The gate never blocks the site: someone it turns away still gets a feed (their last
 * one, or the fallback). If the gate itself is broken (no table, no connection) the
 * request scores as it would without a gate; if it is only slow, that counts as busy.
 */
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm/sql';
import { db } from '../db';
import { getSettings } from './runtime-settings.service';

type Conn = { execute: typeof db.execute };
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

/** Above the 45 s feed timeout, so a live request never loses its slot. */
export const SLOT_LEASE_MS = 60_000;
/** The gate's own queries get this long; slower means the gate is skipped. */
const GATE_QUERY_MS = 2000;
const POLL_MS = 400;

export interface FeedSlot { release: () => Promise<void> }
const OPEN: FeedSlot = { release: async () => {} };

const GATE_TIMEOUT = 'gate query timeout';
const withTimeout = <T>(p: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(GATE_TIMEOUT)), GATE_QUERY_MS); }),
  ]).finally(() => clearTimeout(timer));
};

/** A slot now, or null when all are taken. Fails open. */
export async function tryFeedSlot(conn: Conn = db): Promise<FeedSlot | null> {
  try {
    const { feedGateSlots } = await getSettings();
    const id = randomUUID();
    const got = rows(await withTimeout(conn.execute(sql`
      UPDATE feed_gate_slots SET holder = ${id}, leased_until = NOW() + make_interval(secs => ${SLOT_LEASE_MS / 1000})
      WHERE slot = (
        SELECT slot FROM feed_gate_slots
        WHERE slot <= ${feedGateSlots} AND leased_until < NOW()
        ORDER BY slot LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING slot`)))[0];
    if (!got) {return null;}
    let released = false;
    return {
      release: async () => {
        if (released) {return;}
        released = true;
        await withTimeout(conn.execute(sql`
          UPDATE feed_gate_slots SET holder = NULL, leased_until = 'epoch' WHERE slot = ${got.slot} AND holder = ${id}`))
          .catch(() => {});   // the lease expires on its own
      },
    };
  } catch (err) {
    // Slow means the database or this instance is already overloaded: that is "busy", and
    // letting one more scoring run through would make it worse. Any other failure (no
    // table, no connection) means the gate itself is broken: let the request through.
    if ((err as Error).message === GATE_TIMEOUT) {return null;}
    console.warn(`[feed-gate] unavailable, scoring without a gate: ${(err as Error).message}`);
    return OPEN;
  }
}

/** Wait up to `waitMs` for a slot; null if none freed up. */
export async function waitForFeedSlot(waitMs: number, conn: Conn = db): Promise<FeedSlot | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const slot = await tryFeedSlot(conn);
    if (slot || Date.now() + POLL_MS > deadline) {return slot;}
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
