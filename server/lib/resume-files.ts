/**
 * Resume files: Supabase Storage first, our own Postgres when Supabase can't take
 * the file (outage, free-plan restriction, timeout). An upload never fails just
 * because Supabase is down; the person's resume is saved and parsed either way.
 *
 * A file kept in Postgres has a key starting with `db:` (resume_file_fallback,
 * migrations/add-resume-file-fallback.sql). Links to it are our own short-lived
 * signed links (/api/resume-files/:key), the same shape as Supabase's signed
 * URLs, so every reader works on either. scripts/move-fallback-resumes.ts moves
 * them back to Supabase once it answers again.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { sql } from 'drizzle-orm/sql';
import { db } from '../db';
import { supabaseAdmin } from './supabase-admin';

export const FALLBACK_PREFIX = 'db:';
const BUCKET = 'resumes';
const SUPABASE_UPLOAD_MS = 15_000;
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

export const isFallbackKey = (key: string): boolean => key.startsWith(FALLBACK_PREFIX);

const newName = (): string => `resume-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

function timeout<T>(p: PromiseLike<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    Promise.resolve(p),
    new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Store a resume and return its key. Throws only if neither Supabase nor Postgres took it. */
export async function storeResumeFile(fileBuffer: Buffer, contentType: string): Promise<string> {
  const name = newName();
  try {
    const { error } = await timeout(
      supabaseAdmin.storage.from(BUCKET).upload(name, fileBuffer, { contentType, upsert: true }),
      SUPABASE_UPLOAD_MS, 'Supabase upload');
    if (error) {throw new Error(error.message);}
    return name;
  } catch (err) {
    console.warn(`[resume-files] Supabase upload failed (${(err as Error).message}); keeping the file in Postgres`);
  }
  const key = `${FALLBACK_PREFIX}${name}`;
  await db.execute(sql`
    INSERT INTO resume_file_fallback (key, content, content_type) VALUES (${key}, ${fileBuffer}, ${contentType})`);
  return key;
}

function signingSecret(): string {
  const s = process.env.RESUME_LINK_SECRET || process.env.SUPABASE_JWT_SECRET || '';
  if (!s) {throw new Error('no secret to sign resume links');}
  return s;
}

function signature(key: string, expires: number, download: string): string {
  return createHmac('sha256', signingSecret()).update(`resume-file\n${key}\n${expires}\n${download}`).digest('base64url');
}

/** True when the link parameters were signed by us and haven't expired. */
export function verifyResumeFileLink(key: string, expires: number, download: string, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(expires) || expires * 1000 < now) {return false;}
  const want = Buffer.from(signature(key, expires, download));
  const got = Buffer.from(sig || '');
  return want.length === got.length && timingSafeEqual(want, got);
}

/** A short-lived link to view (or, with `download`, download under that name) a stored resume. */
export async function resumeFileUrl(key: string, expiresInSec: number, download?: string): Promise<string> {
  if (!isFallbackKey(key)) {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET)
      .createSignedUrl(key, expiresInSec, download ? { download } : undefined);
    if (error || !data?.signedUrl) {throw new Error(`Failed to generate resume URL: ${error?.message ?? 'no URL'}`);}
    return data.signedUrl;
  }
  const expires = Math.floor(Date.now() / 1000) + expiresInSec;
  const dl = download ?? '';
  const base = (process.env.FRONTEND_URL || 'https://www.recrutas.ai').replace(/\/$/, '');
  const qs = new URLSearchParams({ e: String(expires), s: signature(key, expires, dl), ...(dl ? { dl } : {}) });
  return `${base}/api/resume-files/${encodeURIComponent(key)}?${qs}`;
}

export interface ResumeFileInfo { contentType: string | null; size: number | null; createdAt: string | null }

/** Type, size and upload time of a stored resume, or null when the file isn't there. */
export async function resumeFileInfo(key: string): Promise<ResumeFileInfo | null> {
  if (!isFallbackKey(key)) {
    const { data } = await supabaseAdmin.storage.from(BUCKET).info(key);
    if (!data) {return null;}
    const d = data as any;
    return {
      contentType: d.contentType || d.metadata?.mimetype || null,
      size: d.size ?? d.metadata?.size ?? null,
      createdAt: d.createdAt || d.created_at || null,
    };
  }
  const r = rows(await db.execute(sql`
    SELECT content_type, octet_length(content) AS size, created_at FROM resume_file_fallback WHERE key = ${key}`))[0];
  return r ? { contentType: r.content_type, size: Number(r.size), createdAt: new Date(r.created_at).toISOString() } : null;
}

/** The bytes of a resume kept in Postgres. */
export async function readFallbackFile(key: string): Promise<{ content: Buffer; contentType: string | null } | null> {
  const r = rows(await db.execute(sql`SELECT content, content_type FROM resume_file_fallback WHERE key = ${key}`))[0];
  return r ? { content: Buffer.from(r.content), contentType: r.content_type } : null;
}

/** Delete a stored resume wherever it is. Returns an error message, or null. */
export async function removeResumeFile(key: string): Promise<string | null> {
  if (isFallbackKey(key)) {
    await db.execute(sql`DELETE FROM resume_file_fallback WHERE key = ${key}`);
    return null;
  }
  const { error } = await supabaseAdmin.storage.from(BUCKET).remove([key]);
  return error ? error.message : null;
}
