/**
 * Check the place resolver (shared/places.ts) on real job locations, after any change to its rules
 * or to the place list.
 *
 *   npx tsx scripts/eval-places.ts summary <locations.csv>...          # share resolved to a city / state / remote / nothing
 *   npx tsx scripts/eval-places.ts sample <seed> <locations.csv>...    # 70 random resolved locations, to read by eye
 *   npx tsx scripts/eval-places.ts place "<name|ST>" <locations.csv>... # the locations that resolve to one place
 *
 * Each CSV is "location,count" (distinct live job locations: Recrutas's, the Fleet's).
 */
import { readFileSync } from 'fs';
import { buildPlaceIndex, resolveLocation } from '../shared/places';

const [mode, arg, ...rest] = process.argv.slice(2);
const files = mode === 'summary' ? [arg, ...rest] : rest;
const data = JSON.parse(readFileSync('client/public/us-places.json', 'utf8'));
const idx = buildPlaceIndex(data.places.map(([n, s, c]: [string, string, number]) => ({ n, s, c })));
const rows: Array<[string, number]> = [];
for (const p of files) {
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^(?:"((?:[^"]|"")*)"|([^,]*)),(\d+)\s*$/.exec(line);
    if (m) {rows.push([(m[1] ?? m[2] ?? '').replace(/""/g, '"'), Number(m[3])]);}
  }
}

if (mode === 'summary') {
  let total = 0; const by = { city: 0, state: 0, remote: 0, none: 0 };
  for (const [loc, n] of rows) {
    total += n;
    const r = resolveLocation(loc, idx);
    by[r.places.length ? 'city' : r.states.length ? 'state' : r.remote ? 'remote' : 'none'] += n;
  }
  const pct = (x: number) => `${(100 * x / total).toFixed(1)}%`;
  console.log(`jobs ${total}: city ${pct(by.city)} | state only ${pct(by.state)} | remote only ${pct(by.remote)} | nothing ${pct(by.none)}`);
} else if (mode === 'sample') {
  let seed = Number(arg) || 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const resolved = rows.filter(([l]) => resolveLocation(l, idx).places.length);
  for (let i = 0; i < 70; i++) {
    const [l] = resolved[Math.floor(rnd() * resolved.length)];
    console.log(JSON.stringify(l.slice(0, 90)), '→', resolveLocation(l, idx).places.join(' + '));
  }
} else if (mode === 'place') {
  const hits = rows.filter(([l]) => resolveLocation(l, idx).places.includes(arg)).sort((a, b) => b[1] - a[1]);
  console.log(`${arg}: ${hits.length} locations, ${hits.reduce((a, b) => a + b[1], 0)} jobs`);
  for (const [l, n] of hits.slice(0, 25)) {console.log(`  ${n}\t${JSON.stringify(l.slice(0, 100))}`);}
} else {
  console.error('usage: eval-places.ts summary|sample <seed>|place "<name|ST>" <locations.csv>...');
  process.exit(1);
}
