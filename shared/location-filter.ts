/**
 * The feed's location filter, shared by the server (SQL) and the dashboard (in memory) so they
 * always agree. Job posts write a place many ways ("Seattle, WA", "Onsite - Seattle",
 * "Greater Seattle Area", "Seattle-Tacoma"), so a city matches as a whole word anywhere in the
 * job's location, and the state only drops jobs that name a different state (Portland, OR is not
 * Portland, ME). Two-letter codes count only in capitals as their own token, so the words "or"
 * and "in" are never read as Oregon or Indiana. The patterns are valid JavaScript and Postgres
 * regexes alike.
 */

export const US_STATES: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
  DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois',
  IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
  NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
  NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
  VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming',
};
const NAME_TO_CODE: Record<string, string> = Object.fromEntries(Object.entries(US_STATES).map(([c, n]) => [n, c]));

export interface LocationFilter { remote?: boolean; city?: string; state?: string }

/** "Seattle, WA" → { city: "seattle", state: "WA" }; "WA" / "Washington" → { state: "WA" }; "Remote" → { remote: true }. */
export function parseLocationFilter(raw: string | null | undefined): LocationFilter | null {
  const text = (raw || '').trim();
  if (!text || text.toLowerCase() === 'all') {return null;}
  if (/^remote$/i.test(text)) {return { remote: true };}
  const parts = text.split(',').map(p => p.trim()).filter(Boolean);
  const stateOf = (p: string): string | undefined => {
    const up = p.toUpperCase().replace(/\./g, '');
    if (US_STATES[up]) {return up;}
    return NAME_TO_CODE[p.toLowerCase()];
  };
  if (parts.length === 1) {
    const s = stateOf(parts[0]);
    return s ? { state: s } : { city: parts[0].toLowerCase() };
  }
  const state = parts.slice(1).map(stateOf).find(Boolean);
  return { city: parts[0].toLowerCase(), ...(state ? { state } : {}) };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Abbreviations posts use for the first word of a place name ("St. Louis", "Ft. Worth", "Mt. Pleasant").
const WORD_FORMS: Record<string, string> = { saint: '(saint|st)', st: '(saint|st)', fort: '(fort|ft)', ft: '(fort|ft)', mount: '(mount|mt)', mt: '(mount|mt)' };
const words = (s: string) => s.split(/[\s.-]+/).filter(Boolean)
  .map(w => WORD_FORMS[w] ?? escapeRe(w)).join('[ .-]+');

/**
 * Other names posts use for a city, by "city|ST". Only unambiguous ones: "LA" is also Louisiana's
 * code, so it is not here.
 */
export const CITY_ALIASES: Record<string, string[]> = {
  'new york|NY': ['nyc', 'new york city', 'manhattan', 'brooklyn', 'queens', 'bronx', 'staten island'],
  'washington|DC': ['dc', 'd c', 'washington dc'],
  'san francisco|CA': ['sf', 'sf bay area'],
};
const cityPattern = (city: string, state?: string): string => {
  const alts = [words(city), ...(CITY_ALIASES[`${city}|${state ?? ''}`] ?? []).map(words)];
  return `(^|[^a-z0-9])(${alts.join('|')})([^a-z0-9]|$)`;
};

export interface LocationPatterns {
  /** Lowercase location must match (city as a whole word, or "remote"). */
  city?: string;
  /** Location must name the chosen state (state-only filter): code (capitals) or name (lowercase). */
  stateCode?: string;
  stateName?: string;
  /** Removed from the lowercase location before looking for other states' names. */
  strip?: string;
  /** Location must NOT name another state: code (capitals, original text) or name (stripped lowercase). */
  otherCodes?: string;
  otherNames?: string;
}

export function locationPatterns(f: LocationFilter): LocationPatterns {
  if (f.remote) {return { city: 'remote' };}
  const p: LocationPatterns = {};
  if (f.city) {p.city = cityPattern(f.city, f.state);}
  if (f.state) {
    const others = Object.keys(US_STATES).filter(c => c !== f.state);
    p.otherCodes = `(^|[ ,(/-])(${others.join('|')})([ ,)/.-]|$)`;
    p.otherNames = `(^|[^a-z])(${others.map(c => words(US_STATES[c])).join('|')})([^a-z]|$)`;
    // The city and the chosen state's own name can contain another state's name
    // ("Washington, DC", "Kansas City, MO", "West Virginia" vs "Virginia").
    p.strip = [f.city ? words(f.city) : null, words(US_STATES[f.state])].filter(Boolean).join('|');
    if (!f.city) {
      p.stateCode = `(^|[ ,(/-])${f.state}([ ,)/.-]|$)`;
      p.stateName = `(^|[^a-z])${words(US_STATES[f.state])}([^a-z]|$)`;
    }
  }
  return p;
}

/** In-memory match, for the dashboard's filtering of jobs it already has. Same rule as the SQL. */
export function locationMatches(jobLocation: string | null | undefined, f: LocationFilter | null): boolean {
  if (!f) {return true;}
  const loc = jobLocation || '';
  const lower = loc.toLowerCase();
  const p = locationPatterns(f);
  if (p.city && !new RegExp(p.city).test(lower)) {return false;}
  if (p.stateCode && !(new RegExp(p.stateCode).test(loc) || new RegExp(p.stateName!).test(lower))) {return false;}
  if (p.otherCodes && new RegExp(p.otherCodes).test(loc)) {return false;}
  if (p.otherNames && new RegExp(p.otherNames).test(p.strip ? lower.replace(new RegExp(p.strip, 'g'), ' ') : lower)) {return false;}
  return true;
}
