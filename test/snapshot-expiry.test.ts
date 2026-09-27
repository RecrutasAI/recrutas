/**
 * Snapshot expiry closes jobs a board stopped listing. The failure it must
 * never have: a bad read (timeout, 404, odd payload, truncated page) looking
 * like an empty board and closing a company's live jobs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  planBoardExpiry, groupSnapshots, groupKey,
  SNAPSHOT_GUARD_MIN_ACTIVE, type BoardSnapshot,
} from '../server/lib/snapshot-expiry';
import { fetchAtsBoard, listAtsJobs } from '../server/lib/adzuna-link-resolver';

const rows = (urls: string[]) => urls.map((u, i) => ({ id: i + 1, externalUrl: u }));
const urls = (n: number, prefix = 'https://x/jobs/') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('planBoardExpiry', () => {
  it('closes only the jobs the board no longer lists', () => {
    const plan = planBoardExpiry(rows(['a', 'b', 'c']), new Set(['a', 'c', 'new']));
    expect(plan).toEqual({ action: 'close', closeIds: [2] });
  });

  it('closes nothing when every active job is still listed', () => {
    expect(planBoardExpiry(rows(['a', 'b']), new Set(['a', 'b']))).toEqual({ action: 'close', closeIds: [] });
  });

  it('never trusts an empty board', () => {
    const plan = planBoardExpiry(rows(['a', 'b']), new Set());
    expect(plan).toEqual({ action: 'skip', reason: 'empty-board', wouldClose: 2 });
  });

  it('skips a board that would lose more than half its jobs at once', () => {
    const active = rows(urls(SNAPSHOT_GUARD_MIN_ACTIVE * 2));
    const seen = new Set(urls(SNAPSHOT_GUARD_MIN_ACTIVE - 1)); // just over half missing
    const plan = planBoardExpiry(active, seen);
    expect(plan.action).toBe('skip');
    expect(plan.action === 'skip' && plan.reason).toBe('mass-drop');
  });

  it('allows exactly half to close', () => {
    const active = rows(urls(SNAPSHOT_GUARD_MIN_ACTIVE * 2));
    const plan = planBoardExpiry(active, new Set(urls(SNAPSHOT_GUARD_MIN_ACTIVE)));
    expect(plan.action === 'close' && plan.closeIds.length).toBe(SNAPSHOT_GUARD_MIN_ACTIVE);
  });

  it('lets a small board churn past the fraction guard', () => {
    const plan = planBoardExpiry(rows(['a', 'b', 'c', 'd']), new Set(['a']));
    expect(plan).toEqual({ action: 'close', closeIds: [2, 3, 4] });
  });

  it('never closes a row it cannot match (no URL)', () => {
    const plan = planBoardExpiry([{ id: 1, externalUrl: null }, { id: 2, externalUrl: 'a' }], new Set(['a']));
    expect(plan).toEqual({ action: 'close', closeIds: [] });
  });
});

describe('groupSnapshots', () => {
  const snap = (o: Partial<BoardSnapshot>): BoardSnapshot =>
    ({ source: 'ATS:greenhouse', company: 'acme', ok: true, complete: true, seenUrls: [], ...o });

  it('unions boards that write the same (source, company)', () => {
    const g = groupSnapshots([snap({ seenUrls: ['a'] }), snap({ seenUrls: ['b'] })]).get(groupKey('ATS:greenhouse', 'acme'))!;
    expect(g.usable).toBe(true);
    expect([...g.seen].sort()).toEqual(['a', 'b']);
  });

  it('distrusts the whole group if any board in it failed', () => {
    const g = groupSnapshots([snap({ seenUrls: ['a'] }), snap({ ok: false })]).get(groupKey('ATS:greenhouse', 'acme'))!;
    expect(g).toMatchObject({ usable: false, reason: 'failed' });
  });

  it('distrusts a partial page', () => {
    const g = groupSnapshots([snap({ complete: false, seenUrls: ['a'] })]).get(groupKey('ATS:greenhouse', 'acme'))!;
    expect(g).toMatchObject({ usable: false, reason: 'incomplete' });
  });

  it('keeps the same company on different ATSes apart', () => {
    const groups = groupSnapshots([snap({}), snap({ source: 'ATS:lever', ok: false })]);
    expect(groups.get(groupKey('ATS:greenhouse', 'acme'))!.usable).toBe(true);
    expect(groups.get(groupKey('ATS:lever', 'acme'))!.usable).toBe(false);
  });
});

describe('fetchAtsBoard', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('reads a greenhouse board, keeping untitled postings in seenUrls', async () => {
    respond(200, { jobs: [
      { title: 'Engineer', absolute_url: 'https://g/1', location: { name: 'NYC' } },
      { title: '', absolute_url: 'https://g/2' },
    ] });
    const b = await fetchAtsBoard('greenhouse', 'acme');
    expect(b).toMatchObject({ ok: true, complete: true, seenUrls: ['https://g/1', 'https://g/2'] });
    expect(b.ok && b.jobs.map(j => j.url)).toEqual(['https://g/1']);
  });

  it('reports a genuinely empty board as ok with no postings', async () => {
    respond(200, { jobs: [] });
    expect(await fetchAtsBoard('greenhouse', 'acme')).toMatchObject({ ok: true, seenUrls: [] });
  });

  it('reports a non-2xx as a failed read, not an empty board', async () => {
    respond(404, {});
    expect(await fetchAtsBoard('greenhouse', 'gone')).toEqual({ ok: false, reason: 'http 404' });
  });

  it('reports a network error as a failed read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await fetchAtsBoard('ashby', 'acme')).toEqual({ ok: false, reason: 'ECONNRESET' });
  });

  it("treats lever's 200 not-found document as a failed read", async () => {
    respond(200, { ok: false, error: 'Document not found' });
    expect((await fetchAtsBoard('lever', 'gone')).ok).toBe(false);
  });

  it('marks a smartrecruiters page short of totalFound as incomplete', async () => {
    respond(200, { totalFound: 250, content: [{ id: '1', name: 'Engineer' }] });
    expect(await fetchAtsBoard('smartrecruiters', 'acme')).toMatchObject({ ok: true, complete: false });
  });

  it('marks a full smartrecruiters board as complete', async () => {
    respond(200, { totalFound: 1, content: [{ id: '1', name: 'Engineer' }] });
    expect(await fetchAtsBoard('smartrecruiters', 'acme')).toMatchObject({ ok: true, complete: true });
  });

  it('keeps listAtsJobs returning [] on a failed read', async () => {
    respond(500, {});
    expect(await listAtsJobs('greenhouse', 'acme')).toEqual([]);
  });
});
