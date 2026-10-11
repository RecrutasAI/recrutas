/**
 * The Fleet's posting-link normalisation (jobs-fleet fleet/ids.py canonical_url), ported so a
 * Recrutas link and a Fleet link for the same posting compare equal. Used to count each job once
 * across both catalogs. Mirrors Python's urlsplit / parse_qsl / urlencode(quote_plus) behaviour;
 * checked against the Python original on every live Recrutas link (scripts/fleet-matcher.ts).
 */
import { createHash } from 'crypto';

const TRACKING_PARAMS = new Set(['gh_src', 'source', 'src', 'ref', 'referrer', 'lever-source', 'lever-origin', 's', 'jobboard', '_ga']);

/** Python's urllib.parse.unquote_plus. */
function unquotePlus(s: string): string {
  const bytes: number[] = [];
  const raw = s.replace(/\+/g, ' ');
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 1, i + 3))) {
      bytes.push(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(c, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Python's urllib.parse.quote_plus (safe: letters, digits, "_.-~"). */
function quotePlus(s: string): string {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const ch = String.fromCharCode(b);
    if (/[A-Za-z0-9_.\-~]/.test(ch)) {out += ch;} else if (ch === ' ') {out += '+';} else {out += '%' + b.toString(16).toUpperCase().padStart(2, '0');}
  }
  return out;
}

export function canonicalUrl(url: string | null | undefined): string {
  if (!url) {return '';}
  const u = String(url).trim();
  // urlsplit: scheme:[//netloc]path[?query][#fragment]
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#.*)?$/.exec(u);
  if (!m) {return u;}
  const [, scheme, netloc = '', rawPath = '', query = ''] = m;
  // parse_qsl(keep_blank_values=True): split on & (and ;? no — Python 3.10+ splits on & only)
  const pairs: Array<[string, string]> = [];
  for (const part of query.split('&')) {
    if (!part) {continue;}
    const eq = part.indexOf('=');
    // parse_qsl drops a field without "=" unless keep_blank_values; with it, "k" -> ("k", "")
    const k = eq === -1 ? part : part.slice(0, eq);
    const v = eq === -1 ? '' : part.slice(eq + 1);
    pairs.push([unquotePlus(k), unquotePlus(v)]);
  }
  const kept = pairs.filter(([k]) => !k.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(k.toLowerCase()));
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const q = kept.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join('&');
  const path = rawPath.replace(/\/+$/, '') || '/';
  // urlunsplit: "//" + netloc is written when netloc is set (or the scheme uses it)
  const base = `${scheme.toLowerCase()}:${netloc || /^(https?|ftp)$/i.test(scheme) ? '//' + netloc.toLowerCase() : ''}${path}`;
  return q ? `${base}?${q}` : base;
}

/** A short fingerprint of the canonical link: 16 hex chars of SHA-1. Same in the matcher. */
export function linkKey(url: string | null | undefined): string {
  return createHash('sha1').update(canonicalUrl(url)).digest('hex').slice(0, 16);
}
