/** Resume files: an upload survives a Supabase outage, and fallback links are signed and expire. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let supabaseUp = true;
const inserted: unknown[] = [];
vi.mock('../server/lib/supabase-admin', () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        upload: async () => (supabaseUp ? { error: null } : { error: { message: 'Service Unavailable' } }),
        createSignedUrl: async (k: string) => ({ data: { signedUrl: `https://supabase.example/sign/${k}` }, error: null }),
      }),
    },
  },
}));
vi.mock('../server/db', () => ({ db: { execute: async (q: unknown) => { inserted.push(q); return []; } } }));
process.env.SUPABASE_JWT_SECRET = 'test-secret';
process.env.FRONTEND_URL = 'https://www.recrutas.ai';
const { storeResumeFile, resumeFileUrl, verifyResumeFileLink, isFallbackKey } = await import('../server/lib/resume-files');

describe('resume files', () => {
  beforeEach(() => { supabaseUp = true; inserted.length = 0; });

  it('stores in Supabase when it answers', async () => {
    const key = await storeResumeFile(Buffer.from('%PDF'), 'application/pdf');
    expect(isFallbackKey(key)).toBe(false);
    expect(inserted).toHaveLength(0);
    expect(await resumeFileUrl(key, 300)).toContain('supabase.example');
  });

  it('keeps the file in Postgres when Supabase refuses it', async () => {
    supabaseUp = false;
    const key = await storeResumeFile(Buffer.from('%PDF'), 'application/pdf');
    expect(isFallbackKey(key)).toBe(true);
    expect(inserted).toHaveLength(1);
  });

  it('signs fallback links, and rejects tampered or expired ones', async () => {
    const key = 'db:resume-1-abc';
    const url = new URL(await resumeFileUrl(key, 300, 'Jane_Doe_Resume.pdf'));
    expect(url.origin + url.pathname).toBe(`https://www.recrutas.ai/api/resume-files/${encodeURIComponent(key)}`);
    const e = Number(url.searchParams.get('e')), s = url.searchParams.get('s')!, dl = url.searchParams.get('dl')!;
    expect(verifyResumeFileLink(key, e, dl, s)).toBe(true);
    expect(verifyResumeFileLink('db:resume-2-xyz', e, dl, s)).toBe(false);        // another file
    expect(verifyResumeFileLink(key, e + 3600, dl, s)).toBe(false);              // stretched expiry
    expect(verifyResumeFileLink(key, e, 'other.pdf', s)).toBe(false);            // other name
    expect(verifyResumeFileLink(key, e, dl, s, (e + 1) * 1000)).toBe(false);     // expired
  });
});
