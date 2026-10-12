/**
 * Build the US place list (client/public/us-places.json): every Census place (2023 Gazetteer) with
 * how many live jobs are in it, plus every state. The location picker suggests from it, and the
 * resolver (shared/places.ts) reads job locations against it.
 *
 *   npx tsx scripts/build-us-places.ts <2023_Gaz_place_national.txt> <locations.csv>...
 *
 * Each locations CSV is "location,count": distinct job locations (Recrutas's live jobs, the
 * Fleet's open US jobs). Counts use only unambiguous readings (a state named, or a name in one
 * state), so they can then settle "Portland" alone (shared/places.ts AMBIGUOUS_SHARE).
 */
import { readFileSync, writeFileSync } from 'fs';
import { US_STATES } from '../shared/location-filter';
import { buildPlaceIndex, resolveLocation, type PlaceRow } from '../shared/places';

const [gazPath, ...locPaths] = process.argv.slice(2);
if (!gazPath || !locPaths.length) {
  console.error('usage: build-us-places.ts <gazetteer.txt> <locations.csv>...');
  process.exit(1);
}

/** Census place name → the name people use: drop the legal suffix ("Seattle city" → "Seattle"). */
const SPECIAL: Record<string, string> = {
  'Nashville-Davidson metropolitan government (balance)': 'Nashville',
  'Louisville/Jefferson County metro government (balance)': 'Louisville',
  'Athens-Clarke County unified government (balance)': 'Athens',
  'Augusta-Richmond County consolidated government (balance)': 'Augusta',
  'Urban Honolulu CDP': 'Honolulu',
  'Boise City city': 'Boise',
  'Indianapolis city (balance)': 'Indianapolis',
  'Milford city (balance)': 'Milford',
  'Butte-Silver Bow (balance)': 'Butte',
};
function placeName(raw: string): string {
  if (SPECIAL[raw]) {return SPECIAL[raw];}
  // Merged city-county governments carry the government's legal name: "Lexington-Fayette urban
  // county", "Macon-Bibb County", "Anaconda-Deer Lodge County". The city is the part before the dash.
  const merged = /^([^-]+)-.+ (County|urban county)( (unified|consolidated|metropolitan) government)?( \(balance\))?$/.exec(raw);
  if (merged) {return merged[1].trim();}
  return raw.replace(/\s*\(balance\)$/, '')
    .replace(/\s+metro township$/i, '')
    .replace(/\s+(city and borough|consolidated government|unified government|metropolitan government|metro government|city|town|village|borough|CDP|municipality|plantation|corporation)$/i, '')
    .trim();
}

const census: PlaceRow[] = [];
const seenPlace = new Set<string>();
for (const line of readFileSync(gazPath, 'utf8').split('\n').slice(1)) {
  const cols = line.split('\t');
  if (cols.length < 4 || !US_STATES[cols[0].trim()]) {continue;}  // states and DC only
  const n = placeName(cols[3].trim());
  const k = `${n}|${cols[0].trim()}`;
  if (!n || seenPlace.has(k)) {continue;}
  seenPlace.add(k);
  census.push({ n, s: cols[0].trim(), c: 0 });
}

const idx = buildPlaceIndex(census);
const counts = new Map<string, number>();
for (const path of locPaths) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^(?:"((?:[^"]|"")*)"|([^,]*)),(\d+)\s*$/.exec(line);
    if (!m) {continue;}
    const loc = (m[1] ?? m[2] ?? '').replace(/""/g, '"');
    for (const key of resolveLocation(loc, idx, false).places) {counts.set(key, (counts.get(key) ?? 0) + Number(m[3]));}
  }
}

const places = census
  .map(p => {
    const key = `${p.n.toLowerCase().replace(/\bsaint\b/g, 'st').replace(/\bfort\b/g, 'ft').replace(/\bmount\b/g, 'mt').replace(/[^a-z0-9]+/g, ' ').trim()}|${p.s}`;
    return { n: p.n, s: p.s, c: counts.get(key) ?? 0 };
  })
  .sort((a, b) => b.c - a.c || a.n.localeCompare(b.n));
const stateJobs = new Map<string, number>();
for (const p of places) {stateJobs.set(p.s, (stateJobs.get(p.s) ?? 0) + p.c);}
const states = Object.entries(US_STATES).map(([code, name]) => ({
  n: name.replace(/\b\w/g, ch => ch.toUpperCase()).replace(/\bOf\b/, 'of'), s: code, c: stateJobs.get(code) ?? 0,
}));
// Compact rows [name, state, jobs]: ~32K places.
writeFileSync('client/public/us-places.json', JSON.stringify({
  built: new Date().toISOString().slice(0, 10),
  places: places.map(p => [p.n, p.s, p.c]),
  states: states.map(p => [p.n, p.s, p.c]),
}));
const withJobs = places.filter(p => p.c > 0);
console.log(`${places.length} places, ${withJobs.length} with jobs; top: ${withJobs.slice(0, 8).map(p => `${p.n}, ${p.s} (${p.c})`).join('; ')}`);
