/**
 * Live switches for running Recrutas without a deploy (docs/scaling-strategy.md, 0.5 and 6a).
 *
 * Settings live in the runtime_settings table and are read through a short
 * in-process cache (SETTINGS_CACHE_MS), so a change reaches every Vercel
 * instance and every VPS cron within about a minute. Each change is written to
 * admin_audit_log with who made it and why.
 *
 * An admin can pin a setting; Autopilot leaves pinned settings alone.
 * If the table is missing or unreachable, every reader gets the defaults, so a
 * settings outage can never take the site down.
 */
import { z } from 'zod';
import { db } from '../db';
import { sql } from 'drizzle-orm/sql';

type Conn = { execute: typeof db.execute };
const rows = (r: any): any[] => (r?.rows ?? r) as any[];

export const SETTING_SCHEMAS = {
  feedCache: z.boolean(),
  feedCacheTtlMinutes: z.number().int().min(5).max(24 * 60),
  signupWaitlist: z.boolean(),
  pauseNonEssentialCrons: z.boolean(),
  noticeBanner: z.object({ text: z.string().trim().min(1).max(200), level: z.enum(['info', 'warning']) }).nullable(),
  autopilot: z.boolean(),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTING_SCHEMAS)[K]> };

export const SETTING_DEFAULTS: Settings = {
  feedCache: true,
  feedCacheTtlMinutes: 120,
  signupWaitlist: false,
  pauseNonEssentialCrons: false,
  noticeBanner: null,
  autopilot: true,
};

/** Plain-language labels the console shows next to each switch. */
export const SETTING_LABELS: Record<SettingKey, { title: string; help: string }> = {
  feedCache: { title: 'Feed cache', help: 'Serve each person\'s ranked feed from cache instead of re-scoring on every visit.' },
  feedCacheTtlMinutes: { title: 'Cached feed lifetime (minutes)', help: 'How long a cached feed is served before it is re-scored. Longer saves CPU.' },
  signupWaitlist: { title: 'Sign-up waitlist', help: 'New sign-ups join a numbered waitlist. People already signed up are not affected.' },
  pauseNonEssentialCrons: { title: 'Pause background jobs', help: 'Pauses discovery, external scrapes, ghost detection and match warming to free CPU for users.' },
  noticeBanner: { title: 'Site notice banner', help: 'A short message shown at the top of the site for everyone.' },
  autopilot: { title: 'Autopilot', help: 'Lets the system flip these switches itself when it is under pressure, and back when it recovers.' },
};

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_SCHEMAS, key);
}

/** Validate a value for a key. Returns the parsed value or an error message an admin can act on. */
export function parseSettingValue(key: SettingKey, value: unknown): { ok: true; value: any } | { ok: false; error: string } {
  const r = SETTING_SCHEMAS[key].safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues.map(i => i.message).join('; ') };
}

/** Stored rows over defaults; an invalid stored value falls back to the default. */
export function mergeSettings(stored: Array<{ key: string; value: unknown }>): Settings {
  const out: any = { ...SETTING_DEFAULTS };
  for (const s of stored) {
    if (!isSettingKey(s.key)) {continue;}
    const parsed = parseSettingValue(s.key, s.value);
    if (parsed.ok) {out[s.key] = parsed.value;}
  }
  return out as Settings;
}

const CACHE_MS = Number(process.env.SETTINGS_CACHE_MS) > 0 ? Number(process.env.SETTINGS_CACHE_MS) : 60_000;
let cached: { at: number; settings: Settings } | null = null;

/** Current settings. Never throws: on any read failure the defaults (or the last good read) are used. */
export async function getSettings(conn: Conn = db, now = Date.now()): Promise<Settings> {
  if (cached && now - cached.at < CACHE_MS) {return cached.settings;}
  try {
    const r = await conn.execute(sql`SELECT key, value FROM runtime_settings`);
    cached = { at: now, settings: mergeSettings(rows(r)) };
  } catch (err) {
    console.warn(`[settings] read failed, using ${cached ? 'last good' : 'default'} values: ${(err as Error).message}`);
    cached = { at: now, settings: cached?.settings ?? { ...SETTING_DEFAULTS } };
  }
  return cached.settings;
}

export function clearSettingsCache(): void { cached = null; }

export interface SettingRow { key: SettingKey; value: unknown; pinned: boolean; updatedBy: string | null; updatedAt: string | null; reason: string | null }

/** Every setting with who last changed it, for the console. */
export async function listSettings(conn: Conn = db): Promise<SettingRow[]> {
  const r = await conn.execute(sql`SELECT key, value, pinned, updated_by, updated_at, reason FROM runtime_settings`);
  const byKey = new Map(rows(r).map((x: any) => [x.key, x]));
  return (Object.keys(SETTING_SCHEMAS) as SettingKey[]).map(key => {
    const x: any = byKey.get(key);
    const parsed = x ? parseSettingValue(key, x.value) : null;
    return {
      key,
      value: parsed?.ok ? parsed.value : SETTING_DEFAULTS[key],
      pinned: !!x?.pinned,
      updatedBy: x?.updated_by ?? null,
      updatedAt: x?.updated_at ? new Date(x.updated_at).toISOString() : null,
      reason: x?.reason ?? null,
    };
  });
}

export async function writeAudit(actor: string, action: string, target: string | null, detail: Record<string, unknown>, reason: string | null, conn: Conn = db): Promise<void> {
  await conn.execute(sql`
    INSERT INTO admin_audit_log (actor, action, target, detail, reason)
    VALUES (${actor}, ${action}, ${target}, ${JSON.stringify(detail)}::jsonb, ${reason})`);
}

/**
 * Change a setting. `actor` is an admin's email or 'autopilot'. Autopilot may not
 * change a pinned setting; admins can, and can pin or unpin it in the same call.
 */
export async function setSetting(
  key: SettingKey, value: unknown, actor: string, reason: string,
  opts: { pinned?: boolean } = {}, conn: Conn = db,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = parseSettingValue(key, value);
  if (!parsed.ok) {return parsed;}
  if (!reason.trim()) {return { ok: false, error: 'A reason is required.' };}
  const current = rows(await conn.execute(sql`SELECT value, pinned FROM runtime_settings WHERE key = ${key}`))[0];
  if (actor === 'autopilot' && current?.pinned) {return { ok: false, error: `${key} is pinned by an admin.` };}
  const pinned = opts.pinned ?? !!current?.pinned;
  await conn.execute(sql`
    INSERT INTO runtime_settings (key, value, pinned, updated_by, updated_at, reason)
    VALUES (${key}, ${JSON.stringify(parsed.value)}::jsonb, ${pinned}, ${actor}, NOW(), ${reason})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, pinned = EXCLUDED.pinned,
      updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at, reason = EXCLUDED.reason`);
  await writeAudit(actor, 'setting.change', key, { from: current?.value ?? SETTING_DEFAULTS[key], to: parsed.value, pinned }, reason, conn);
  clearSettingsCache();
  return { ok: true };
}

export async function recentAudit(limit = 50, conn: Conn = db): Promise<any[]> {
  const r = await conn.execute(sql`
    SELECT id, at, actor, action, target, detail, reason FROM admin_audit_log ORDER BY at DESC LIMIT ${limit}`);
  return rows(r);
}
