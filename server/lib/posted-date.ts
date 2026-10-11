/**
 * Posting dates as job sources give them. Shared by the scrapers so each reads the employer's own
 * date the same way, and none falls back to "now" (that made jobs posted days ago show as new).
 */

/** An ATS date (ISO string, "2026-10-05 13:25:03 UTC", "2026-10-05", or epoch ms) as a Date, or null. */
export function parseSourceDate(v: unknown): Date | null {
  if (v == null || v === '') {return null;}
  const d = typeof v === 'number'
    ? new Date(v)
    : new Date(String(v).trim().replace(/ UTC$/, 'Z').replace(/^(\d{4}-\d\d-\d\d) (\d)/, '$1T$2'));
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Workday's listing says "Posted Today", "Posted Yesterday", "Posted 3 Days Ago" or
 * "Posted 30+ Days Ago", relative to when it was read. The day, or null when it isn't one
 * ("30+" is a range, not a date).
 */
export function workdayPostedOn(text: string | null | undefined, now: Date = new Date()): Date | null {
  const t = (text || '').trim().toLowerCase();
  if (!t || t.includes('+')) {return null;}
  let days: number;
  if (t.includes('today')) {days = 0;}
  else if (t.includes('yesterday')) {days = 1;}
  else {
    const m = /posted\s+(\d+)\s+days?\s+ago/.exec(t);
    if (!m) {return null;}
    days = Number(m[1]);
  }
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days, 12));
  return d;
}
