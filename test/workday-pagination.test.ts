/**
 * Workday's public jobs API rejects page sizes above 20 with a 400. A single
 * `limit: 100` request silently emptied Salesforce (1,536 jobs), Adobe (408)
 * and Workday (386) in every scrape until 2026-10-08. The fetcher now pages
 * through the board 20 at a time, reading the total from the first page only.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchFromATS } from '../server/scraper-v2/strategies/ats-apis';

const API = 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs';
const company: any = { id: 'acme', name: 'Acme', careerPageUrl: 'https://acme.example/careers', ats: { type: 'workday', customApiUrl: API } };

function board(total: number, opts: { failAt?: number } = {}) {
  const bodies: any[] = [];
  const fetchMock = vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if (body.limit > 20) {return new Response('{"errorCode":"HTTP_400"}', { status: 400 });}
    if (opts.failAt !== undefined && body.offset >= opts.failAt) {return new Response('', { status: 500 });}
    const n = Math.max(0, Math.min(body.limit, total - body.offset));
    const jobPostings = Array.from({ length: n }, (_, i) => ({
      title: `Job ${body.offset + i}`, externalPath: `/job/US/Job-${body.offset + i}`, locationsText: 'San Francisco, CA',
    }));
    // Like the real API, only the first page reports the total.
    return new Response(JSON.stringify({ total: body.offset === 0 ? total : 0, jobPostings }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, bodies };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('Workday fetch', () => {
  it('pages 20 at a time until the board total', async () => {
    const { bodies } = board(53);
    const jobs = await fetchFromATS(company);
    expect(jobs).toHaveLength(53);
    expect(bodies.map(b => [b.limit, b.offset])).toEqual([[20, 0], [20, 20], [20, 40]]);
    expect(new Set(jobs.map(j => j.externalUrl)).size).toBe(53);
    expect(jobs[52].externalUrl).toBe('https://acme.wd5.myworkdayjobs.com/External/job/US/Job-52');
  });

  it('never asks for more than 20 per page', async () => {
    const { bodies } = board(5);
    await fetchFromATS(company);
    expect(Math.max(...bodies.map(b => b.limit))).toBeLessThanOrEqual(20);
  });

  it('keeps the jobs it already has when a later page fails', async () => {
    board(100, { failAt: 40 });
    const jobs = await fetchFromATS(company);
    expect(jobs).toHaveLength(40);
  });

  it('throws when the first page fails', async () => {
    board(100, { failAt: 0 });
    await expect(fetchFromATS(company)).rejects.toThrow(/Workday API returned 500/);
  });
});
