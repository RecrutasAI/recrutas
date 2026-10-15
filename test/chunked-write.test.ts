import { describe, it, expect } from 'vitest';
import { isStatementTimeout, writeInChunks } from '../server/lib/chunked-write';

/** A fake database: each row costs `msPerRow`, and a statement over `timeoutMs` fails like Postgres. */
function fakeDb(msPerRow: number, timeoutMs = 20_000) {
  let clock = 0;
  const chunks: number[] = [];
  const write = async (chunk: number[]) => {
    const cost = chunk.length * msPerRow;
    if (cost > timeoutMs) {
      clock += timeoutMs;
      throw Object.assign(new Error('Failed query: UPDATE job_postings ...'), { cause: Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) });
    }
    clock += cost;
    chunks.push(chunk.length);
    return chunk.length;
  };
  return { write, now: () => clock, chunks };
}

describe('writeInChunks', () => {
  it('writes the 2,813 rows that timed out on 2026-10-14 (23 ms a row), every chunk under the limit', async () => {
    const db = fakeDb(23);
    const ids = Array.from({ length: 2813 }, (_, i) => i);
    expect(await writeInChunks(ids, db.write, {}, db.now)).toBe(2813);
    expect(Math.max(...db.chunks) * 23).toBeLessThan(20_000);
  });

  it('recovers when the first chunk is already too big, by retrying smaller', async () => {
    const db = fakeDb(200); // a very slow day: 200 ms a row
    const ids = Array.from({ length: 1000 }, (_, i) => i);
    expect(await writeInChunks(ids, db.write, { start: 500 }, db.now)).toBe(1000);
    expect(db.chunks.every(n => n * 200 <= 20_000)).toBe(true);
  });

  it('grows chunks when rows are cheap, so fast days stay fast', async () => {
    const db = fakeDb(1);
    await writeInChunks(Array.from({ length: 5000 }, (_, i) => i), db.write, {}, db.now);
    expect(db.chunks[0]).toBe(200);
    expect(Math.max(...db.chunks)).toBe(2000);
  });

  it('other errors are not swallowed', async () => {
    const write = async () => { throw new Error('duplicate key value'); };
    await expect(writeInChunks([1, 2, 3], write)).rejects.toThrow('duplicate key');
  });

  it('recognizes a statement timeout wrapped by the driver', () => {
    expect(isStatementTimeout({ message: 'Failed query', cause: { code: '57014' } })).toBe(true);
    expect(isStatementTimeout(new Error('connection reset'))).toBe(false);
  });
});
