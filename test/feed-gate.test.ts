/** The feed gate caps concurrent scoring and can only ever let more through, never block. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/db', () => ({ db: {} }));
vi.mock('../server/services/runtime-settings.service', () => ({ getSettings: async () => ({ feedGateSlots: 2 }) }));
const { tryFeedSlot, waitForFeedSlot } = await import('../server/services/feed-gate.service');

// Stands in for feed_gate_slots: acquire takes a free slot up to the cap, release frees it.
let held = new Set<number>();
let mode: 'ok' | 'down' | 'hang' = 'ok';
const conn = {
  execute: async (q: unknown) => {
    if (mode === 'down') {throw new Error('connection refused');}
    if (mode === 'hang') {return new Promise(() => {});}
    const text = JSON.stringify(q);
    if (text.includes('SKIP LOCKED')) {
      for (const s of [1, 2]) {if (!held.has(s)) { held.add(s); return [{ slot: s }]; }}
      return [];
    }
    const slot = (q as any).queryChunks?.find((c: unknown) => typeof c === 'number');
    held.delete(slot ?? [...held][0]);
    return [];
  },
} as any;

describe('feed gate', () => {
  beforeEach(() => { held = new Set(); mode = 'ok'; });

  it('gives out only as many slots as the setting allows, and frees them on release', async () => {
    const a = await tryFeedSlot(conn), b = await tryFeedSlot(conn);
    expect(a && b).toBeTruthy();
    expect(await tryFeedSlot(conn)).toBeNull();
    await a!.release();
    await a!.release();   // twice is harmless
    expect(await tryFeedSlot(conn)).not.toBeNull();
  });

  it('waits for a slot to free up, and gives up after the wait', async () => {
    const a = await tryFeedSlot(conn); await tryFeedSlot(conn);
    setTimeout(() => { void a!.release(); }, 300);
    expect(await waitForFeedSlot(2000, conn)).not.toBeNull();
    expect(await waitForFeedSlot(500, conn)).toBeNull();
  });

  it('lets the request through when the gate is broken', async () => {
    mode = 'down';
    expect(await tryFeedSlot(conn)).not.toBeNull();
  });

  it('counts a slow gate as busy (the database is already overloaded), within about 2 s', async () => {
    mode = 'hang';
    const t = Date.now();
    expect(await tryFeedSlot(conn)).toBeNull();
    expect(Date.now() - t).toBeLessThan(3000);
  });
});
