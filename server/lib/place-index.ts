/**
 * The US place list (client/public/us-places.json) as a resolver index, loaded once. Used where
 * jobs are saved and by the location-keys backfill; both run on the VPS, which has the file.
 * Without it (a bundle that left it out) this returns null and the job keeps no keys until the
 * backfill fills them: never wrong keys.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { buildPlaceIndex, locationKeys, type PlaceIndex } from '../../shared/places';

let cached: PlaceIndex | null | undefined;

export function placeIndex(): PlaceIndex | null {
  if (cached !== undefined) {return cached;}
  const file = [join(process.cwd(), 'client/public/us-places.json'), join(process.cwd(), 'dist/public/us-places.json')]
    .find(existsSync);
  try {
    const data = file ? JSON.parse(readFileSync(file, 'utf8')) : null;
    cached = data ? buildPlaceIndex((data.places as Array<[string, string, number]>).map(([n, s, c]) => ({ n, s, c }))) : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** A job location's keys, or null when the place list isn't available here. */
export function keysForLocation(location: string | null | undefined): string[] | null {
  const idx = placeIndex();
  return idx ? locationKeys(location, idx) : null;
}
