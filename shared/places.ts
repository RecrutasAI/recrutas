/**
 * Which US places a job's location means, however the post writes it.
 *
 * Posts write a place many ways ("Seattle, WA", "Onsite - Seattle", "Greater Seattle Area",
 * "Seattle-Tacoma, WA", "NYC", "Brooklyn, NY", "Kansas City, MO", "Washington, D.C."). This reads
 * the text against the Census list of US places (client/public/us-places.json) and returns
 * place keys ("seattle|WA"). The job feed filters on those keys, so a chosen city returns every
 * job resolved to it and nothing else. One resolver for ingestion, the backfill and the
 * place-list build, so they always agree.
 *
 * Rules (each checked on every distinct live job location, 2026-10-11):
 *   - a place name counts with its state named anywhere in the location ("Portland, OR"), or alone
 *     when the name is in one state only ("Seattle"), or, for a name in several states, when one
 *     state holds at least 75% of that name's jobs ("Portland" → Portland, OR);
 *   - a state named inside a city's own words is not that state ("Kansas" in "Kansas City");
 *   - a state's full name is a city only when it opens the location and a named state has a city
 *     of that name ("New York, NY", "Washington, DC"); elsewhere it is the state;
 *   - words that are places but usually mean something else in a job location ("Remote",
 *     "Commerce", "Mobile") count only with their state named.
 */
import { US_STATES } from './location-filter';

export const normPlace = (s: string): string => s.toLowerCase()
  .replace(/\bsaint\b/g, 'st').replace(/\bfort\b/g, 'ft').replace(/\bmount\b/g, 'mt')
  .replace(/[^a-z0-9]+/g, ' ').trim();

export const placeKey = (name: string, st: string): string => `${normPlace(name)}|${st}`;
export const stateKey = (st: string): string => `state|${st}`;

/** Other names posts use for a city, by "name|ST" (normalized). Only unambiguous ones: "LA" is also Louisiana. */
export const PLACE_ALIASES: Record<string, string[]> = {
  'new york|NY': ['nyc', 'new york city', 'manhattan', 'brooklyn', 'queens', 'bronx', 'staten island'],
  'washington|DC': ['dc', 'd c', 'washington dc', 'washington d c', 'district of columbia'],
  'san francisco|CA': ['sf', 'sf bay area'],
};

/** Parts of a city that posts write like places (New York's boroughs). */
export const CITY_PARTS = new Set(['manhattan', 'brooklyn', 'queens', 'bronx', 'staten island']);

/** Place names that usually mean something else in a job location; counted only with their state. */
export const NOT_A_PLACE = new Set(['remote', 'hybrid', 'onsite', 'on site', 'office', 'home', 'virtual', 'anywhere', 'united',
  'national', 'field', 'multiple', 'various', 'travel', 'flexible', 'usa', 'us', 'america', 'north', 'south', 'east', 'west',
  'central', 'commerce', 'industry', 'mobile', 'normal', 'independence', 'liberty', 'union', 'enterprise', 'progress',
  'opportunity', 'success', 'friendship', 'harmony', 'unity', 'energy', 'power', 'security', 'justice', 'paradise', 'eureka',
  'hope', 'global', 'worldwide', 'nationwide', 'corporate', 'headquarters', 'hq', 'main', 'campus', 'plant', 'site']);

/** Countries other than the US, as posts write them. A location naming one and no US state is not
 * in the US ("Healesville, Victoria, Australia" is not Victoria, TX). */
const OTHER_COUNTRIES = new Set(['canada', 'mexico', 'united kingdom', 'uk', 'england', 'scotland', 'wales', 'ireland', 'india',
  'australia', 'new zealand', 'germany', 'france', 'spain', 'portugal', 'italy', 'netherlands', 'belgium', 'switzerland',
  'austria', 'poland', 'czech republic', 'czechia', 'hungary', 'romania', 'bulgaria', 'greece', 'sweden', 'norway', 'denmark',
  'finland', 'estonia', 'latvia', 'lithuania', 'ukraine', 'turkey', 'israel', 'egypt', 'south africa', 'nigeria', 'kenya',
  'morocco', 'uae', 'united arab emirates', 'saudi arabia', 'qatar', 'singapore', 'malaysia', 'indonesia', 'philippines',
  'thailand', 'vietnam', 'japan', 'south korea', 'korea', 'china', 'hong kong', 'taiwan', 'pakistan', 'bangladesh', 'sri lanka',
  'brazil', 'argentina', 'chile', 'colombia', 'peru', 'costa rica', 'guatemala', 'dominican republic', 'jamaica', 'puerto rico',
  'serbia', 'croatia', 'slovakia', 'slovenia', 'luxembourg', 'iceland', 'cyprus', 'malta', 'emea', 'apac', 'latam', 'europe', 'asia',
  // Canadian provinces, written without the country ("Greater Sudbury, Ontario")
  'ontario', 'quebec', 'british columbia', 'alberta', 'manitoba', 'saskatchewan', 'nova scotia', 'new brunswick',
  'newfoundland and labrador', 'prince edward island']);

/** A share at or above this of a name's jobs makes "Portland" alone mean Portland, OR. */
export const AMBIGUOUS_SHARE = 0.75;

export interface PlaceRow { n: string; s: string; c: number }
export interface PlaceIndex {
  /** normalized name → state → { display name, jobs } */
  byName: Map<string, Map<string, { name: string; jobs: number }>>;
  aliases: Map<string, string>;  // normalized alias → normalized name|ST
}

export function buildPlaceIndex(rows: PlaceRow[]): PlaceIndex {
  const byName = new Map<string, Map<string, { name: string; jobs: number }>>();
  for (const r of rows) {
    if (!US_STATES[r.s]) {continue;}
    const key = normPlace(r.n);
    if (!key) {continue;}
    if (!byName.has(key)) {byName.set(key, new Map());}
    const prev = byName.get(key)!.get(r.s);
    byName.get(key)!.set(r.s, { name: r.n, jobs: (prev?.jobs ?? 0) + (r.c || 0) });
  }
  const aliases = new Map<string, string>();
  for (const [key, alts] of Object.entries(PLACE_ALIASES)) {for (const a of alts) {aliases.set(normPlace(a), key);}}
  return { byName, aliases };
}

const STATE_NAME_TO_CODE = new Map(Object.entries(US_STATES).map(([c, n]) => [normPlace(n), c]));
const MAX_WORDS = 4;

export interface Resolved {
  /** Place keys, "seattle|WA". */
  places: string[];
  /** States named or implied by the places, "WA". */
  states: string[];
  remote: boolean;
}

/**
 * Words that may sit next to a place within one part of a location without making it a different
 * place: "Greater Seattle Area", "Seattle WA 98101", "Hybrid in Seattle", "City of Chicago".
 */
const FILLER = new Set(['us', 'usa', 'u s', 'united', 'states', 'america', 'of', 'greater', 'area', 'metro', 'metropolitan',
  'region', 'downtown', 'city', 'hybrid', 'remote', 'onsite', 'on', 'site', 'office', 'in', 'at', 'near', 'based',
  'or', 'and', 'location', 'locations', 'hq', 'headquarters', 'only', 'flexible', 'preferred', 'required', 'within',
  'commutable', 'distance', 'to', 'from', 'home', 'hub', 'tbd', 'multiple', 'various', 'any', 'nationwide', 'relo',
  'relocation', 'full', 'time', 'part', 'temporary', 'contract']);

/** A location's parts: split at commas, " - ", "|", ";", "/", parentheses and "or"/"and". */
function parts(raw: string): string[] {
  // "or"/"and" join places ("Austin OR Chicago"), but ", OR" after a comma is Oregon.
  return raw.split(/[,;|()/•·\n\t]+|\s+[-–—]\s+|(?<![,|;])\s+(?:or|and|&)\s+/i).map(p => p.trim()).filter(Boolean);
}

export function resolveLocation(location: string | null | undefined, idx: PlaceIndex, useShares = true): Resolved {
  const raw = location || '';
  const codes = new Set<string>();
  for (const m of raw.matchAll(/(?:^|[ ,(/;|-])([A-Z]{2})(?=[ ,)/.;|-]|$)/g)) {if (US_STATES[m[1]]) {codes.add(m[1]);}}
  // Tokens of every part, with where each part starts, so state names are found once for the whole text.
  const segs = parts(raw).map(p => normPlace(p).split(' ').filter(Boolean));
  const tokens = segs.flat();
  const segStart: number[] = [];
  segs.reduce((at, seg) => { segStart.push(at); return at + seg.length; }, 0);
  const nameSpans: Array<{ start: number; end: number; code: string }> = [];
  for (const [name, code] of STATE_NAME_TO_CODE) {
    const w = name.split(' ');
    for (const [si, seg] of segs.entries()) {
      for (let i = 0; i + w.length <= seg.length; i++) {
        if (w.every((x, j) => seg[i + j] === x)) {nameSpans.push({ start: segStart[si] + i, end: segStart[si] + i + w.length, code });}
      }
    }
  }
  // Other names count as naming their state ("Ridgewood, Queens" is in New York).
  for (const seg of segs) {
    for (let i = 0; i < seg.length; i++) {
      for (let k = 1; k <= MAX_WORDS && i + k <= seg.length; k++) {
        const a = idx.aliases.get(seg.slice(i, i + k).join(' '));
        if (a) {codes.add(a.split('|')[1]);}
      }
    }
  }
  const statesOutside = (i: number, k: number): Set<string> => {
    const out = new Set(codes);
    for (const sp of nameSpans) {if (sp.end <= i || sp.start >= i + k) {out.add(sp.code);}}
    return out;
  };
  // "New York, NY", "Florida, New York", "Washington, PA": the part right after a state's name
  // names the state the city is in. Without that ("Florida, Tallahassee, FL"), it is the state.
  const nextPartConfirms = (si: number, endInSeg: number, st: string): boolean => {
    if (endInSeg < segs[si].length) {return false;}
    const next = segs[si + 1];
    // The whole location is the name: the city only if it is in the state of that name
    // ("New York" is New York City; "Florida" alone is the state, not Florida, NY).
    if (!next) {return si === 0 && STATE_NAME_TO_CODE.get(segs[si].join(' ')) === st;}
    if (next[0] && next[0].length === 2 && next[0].toUpperCase() === st) {return true;}
    // The next part is another name of the same city ("Washington, D.C.", "Washington, D.C. Metro
    // Area": "D.C." is Washington, DC).
    if (idx.aliases.get(next.filter(t => !FILLER.has(t)).join(' ')) === `${segs[si].join(' ')}|${st}`) {return true;}
    // The city written twice, the second time confirmed ("Washington, Washington, D.C.").
    if (next.join(' ') === segs[si].join(' ') && nextPartConfirms(si + 1, next.length, st)) {return true;}
    const name = normPlace(US_STATES[st] ?? '');
    return !!name && next.slice(0, name.split(' ').length).join(' ') === name;
  };
  // The state written right after a place, in the same part ("Seattle WA 98101") or as the next
  // part ("Boston, Massachusetts"): it decides the place's state before anything said elsewhere
  // ("Atlanta, Georgia; Boston, Massachusetts" — Georgia has a Boston too).
  const stateRightAfter = (si: number, endInSeg: number): { code: string; byName: boolean } | undefined => {
    const rest = endInSeg < segs[si].length ? segs[si].slice(endInSeg) : (segs[si + 1] ?? []);
    if (!rest.length) {return undefined;}
    if (rest[0].length === 2 && US_STATES[rest[0].toUpperCase()]) {return { code: rest[0].toUpperCase(), byName: false };}
    for (const [name, code] of STATE_NAME_TO_CODE) {
      const w = name.split(' ');
      if (rest.slice(0, w.length).join(' ') === name) {return { code, byName: true };}
    }
    return undefined;
  };
  // "Ridgewood, Queens", "Williamsburg, Brooklyn": a name followed by a part of a city is a
  // neighborhood of that city, not a town elsewhere.
  const nextIsPartOfCity = (si: number, endInSeg: number): boolean =>
    endInSeg === segs[si].length && !!segs[si + 1] && CITY_PARTS.has(segs[si + 1].join(' '));
  const isFiller = (t: string) => FILLER.has(t) || /^\d+$/.test(t) || (t.length === 2 && !!US_STATES[t.toUpperCase()]);

  const remote = /\b(remote|work from home|wfh|anywhere|virtual)\b/i.test(raw);
  const foreign = segs.some(seg => OTHER_COUNTRIES.has(seg.join(' ')) || OTHER_COUNTRIES.has(seg.slice(-2).join(' ')) || OTHER_COUNTRIES.has(seg[seg.length - 1] ?? ''));
  if (foreign && !codes.size && !nameSpans.length) {return { places: [], states: [], remote };}

  const places = new Set<string>();
  const states = new Set<string>(codes);
  let prevBareCity = false;
  const segFound: Array<{ keys: string[]; label: boolean }> = [];   // the part before was a city with no state written after it
  for (const [si, seg] of segs.entries()) {
    // A part starting with a street number is an address ("900 Winston", "220 Bend"), not a place.
    if (seg.length > 1 && /^\d+$/.test(seg[0])) {prevBareCity = false; continue;}
    const bareBefore = prevBareCity;
    prevBareCity = false;
    let usedNextState = false;
    const found: string[] = [];
    const covered = new Array(seg.length).fill(false);
    for (let i = 0; i < seg.length; i++) {
      for (let k = Math.min(MAX_WORDS, seg.length - i); k >= 1; k--) {
        const gram = seg.slice(i, i + k).join(' ');
        const at = segStart[si] + i;
        const aliasKey = idx.aliases.get(gram);
        const isStateName = !aliasKey && STATE_NAME_TO_CODE.has(gram);
        const candidates = aliasKey ? null : idx.byName.get(gram);
        if (!aliasKey && !candidates && !isStateName) {continue;}

        let key: string | undefined;
        if (aliasKey) {
          key = aliasKey;
        } else if (candidates) {
          const named = statesOutside(at, k);
          const inNamed = [...candidates.keys()].filter(st => named.has(st));
          const after = stateRightAfter(si, i + k);
          let st: string | undefined;
          // A state code right after the name decides it: that state, or none (a different place,
          // or a typo), never a same-name place elsewhere. A state's NAME right after decides it
          // only when the place is in that state ("Albany, New York"); otherwise it is the next
          // city of a list ("Seattle, New York").
          const wholePart = seg.every((t, j) => (j >= i && j < i + k) || isFiller(t));
          // A state code written in the same part, before the name ("US-NV-Las Vegas"), decides it.
          const ownCodes = seg.slice(0, i).filter(t => t.length === 2 && !!US_STATES[t.toUpperCase()]).map(t => t.toUpperCase());
          // The next part is another name of this very place ("Washington, D.C."): that place,
          // whatever other states the location names ("Maryland; Virginia; Washington, D.C.").
          const sameAfter = i + k === seg.length && segs[si + 1]
            ? idx.aliases.get(segs[si + 1].filter(t => !FILLER.has(t)).join(' ')) : undefined;
          if (nextIsPartOfCity(si, i + k)) {st = undefined;}
          else if (sameAfter?.startsWith(`${gram}|`) && candidates.has(sameAfter.split('|')[1])) {st = sameAfter.split('|')[1];}
          // Words that are usually not places ("Home Office", "Remote") count only with a state
          // code right after them.
          else if (NOT_A_PLACE.has(gram)) {st = after && !after.byName && candidates.has(after.code) ? after.code : undefined;}
          else if (ownCodes.length && candidates.has(ownCodes[ownCodes.length - 1])) {st = ownCodes[ownCodes.length - 1];}
          else if (after && (!after.byName || candidates.has(after.code))) {
            st = candidates.has(after.code) ? after.code : undefined;
            if (st && i + k === seg.length) {usedNextState = true;}
          } else if (inNamed.length === 1) {st = inNamed[0];}
          // In a list of bare names ("San Francisco, Seattle, New York"), states named for other
          // places don't rule a name out: a name in one state only is that place, and a shared
          // name goes to the state that clearly has most of its jobs.
          else if (inNamed.length === 0 && (wholePart || !named.size)) {
            if (candidates.size === 1) {st = [...candidates.keys()][0];}
            else if (useShares) {
              const total = [...candidates.values()].reduce((a, b) => a + b.jobs, 0);
              const top = [...candidates.entries()].sort((a, b) => b[1].jobs - a[1].jobs)[0];
              if (total > 0 && top[1].jobs / total >= AMBIGUOUS_SHARE) {st = top[0];}
            }
          }
          if (st) {key = `${gram}|${st}`;}
        }
        // A state's full name is a city only when the part after it confirms the city's state
        // ("New York, NY", "New York, New York", "Washington, PA"); anywhere else it is the state,
        // and its words are used up so "York" in "New York" is never read as York.
        // In a list of bare city names, a state's name standing alone is its own-named city
        // ("San Francisco, Seattle, New York"), unless it follows a place as that place's state.
        const listCity = isStateName && !!key && bareBefore && k === seg.length
          && STATE_NAME_TO_CODE.get(gram) === key.split('|')[1];
        if (isStateName && !listCity && (!key || !nextPartConfirms(si, i + k, key.split('|')[1]))) {
          states.add(STATE_NAME_TO_CODE.get(gram)!);
          for (let j = i; j < i + k; j++) {covered[j] = true;}
          i += k - 1;
          break;
        }
        if (!key) {continue;}
        found.push(key);
        for (let j = i; j < i + k; j++) {covered[j] = true;}
        i += k - 1;
        break;
      }
    }
    // A place counts only when it makes up its part: "Bay Point Golf Club" is not Golf, FL, and
    // "North Reading" is not Reading.
    const whole = seg.every((t, j) => covered[j] || isFiller(t));
    if (whole && found.length) {segFound.push({ keys: found, label: found.length > 1 && !seg.some(t => t.length === 2 && !!US_STATES[t.toUpperCase()]) });}
    // A city with nothing after it naming its state: the next bare name is part of the same list.
    prevBareCity = whole && found.length > 0 && !usedNextState && !seg.some(t => t.length === 2 && !!US_STATES[t.toUpperCase()]);
  }
  // A part that runs two place names together with no state ("Austin Burnet 019 - Austin, TX") is a
  // store or site label when another part of the location names the place on its own.
  const hasPlainPart = segFound.some(f => !f.label);
  for (const f of segFound) {
    if (f.label && hasPlainPart) {continue;}
    for (const key of f.keys) {places.add(key); states.add(key.split('|')[1]);}
  }
  return { places: [...places], states: [...states], remote };
}

/** The keys stored on a job: its places, its states, and "remote" when it says so. */
export function locationKeys(location: string | null | undefined, idx: PlaceIndex): string[] {
  const r = resolveLocation(location, idx);
  return [...r.places, ...r.states.map(stateKey), ...(r.remote ? ['remote'] : [])];
}

/** The key a picked place filters on: "Seattle, WA" → "seattle|WA", "WA"/"Washington" → "state|WA", "Remote" → "remote". */
export function pickedKey(pick: string | null | undefined): string | null {
  const t = (pick || '').trim();
  if (!t || t.toLowerCase() === 'all') {return null;}
  if (/^remote$/i.test(t)) {return 'remote';}
  const alias = Object.entries(PLACE_ALIASES).find(([, alts]) => alts.includes(normPlace(t)));
  if (alias) {return alias[0];}
  const parts = t.split(',').map(p => p.trim()).filter(Boolean);
  const asState = (p: string): string | undefined => {
    const up = p.toUpperCase().replace(/\./g, '');
    if (US_STATES[up]) {return up;}
    return STATE_NAME_TO_CODE.get(normPlace(p));
  };
  if (parts.length === 1) {
    const st = asState(parts[0]);
    return st ? stateKey(st) : null;
  }
  const st = asState(parts[parts.length - 1]);
  if (!st) {return null;}
  return `${normPlace(parts.slice(0, -1).join(' '))}|${st}`;
}
