/**
 * Job locations → US places (shared/places.ts), on the real place list. Every location below is a
 * real one from live jobs (2026-10-11), including each one that was resolved wrong while the
 * rules were built.
 */
import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { buildPlaceIndex, resolveLocation, locationKeys, pickedKey } from '../shared/places';

const data = JSON.parse(readFileSync('client/public/us-places.json', 'utf8'));
const idx = buildPlaceIndex(data.places.map(([n, s, c]: [string, string, number]) => ({ n, s, c })));
const places = (loc: string) => resolveLocation(loc, idx).places.sort();

describe('resolveLocation', () => {
  it('finds a city however the post writes it', () => {
    for (const loc of ['Seattle, WA', 'Seattle, WA, United States', 'Seattle, Washington, United States', 'Onsite - Seattle',
      'Greater Seattle Area', 'SEATTLE WA 98101', 'Hybrid (Seattle, Washington)', 'Queen Anne Community Center - Seattle, WA 98119',
      'USA - Seattle, WA', 'Remote or Seattle']) {
      expect(places(loc), loc).toContain('seattle|WA');
    }
    expect(places('Seattle-Tacoma, WA')).toEqual(['seattle|WA', 'tacoma|WA']);
  });

  it('reads other names for a city', () => {
    for (const loc of ['NYC', 'New York City, NY, us', 'Wyckoff - Brooklyn, NY 11237', 'Ridgewood, Queens, United States', 'New York, New York, United States']) {
      expect(places(loc), loc).toEqual(['new york|NY']);
    }
    for (const loc of ['Washington, DC', 'Washington, D.C. - Washington, D.C., DC 20004', 'Washington, District of Columbia, United States']) {
      expect(places(loc), loc).toEqual(['washington|DC']);
    }
    expect(places('St. Louis, MO')).toEqual(['st louis|MO']);
    // D.C. is not Washington state, however it's written (650 live jobs were tagged WA, 2026-10-12).
    for (const loc of ['Washington, D.C.', 'Washington D.C.', 'Washington D.C', 'Washington, D.C', 'Washington, Washington, D.C.',
      'Washington, D.C., United States', 'Washington, D.C. United States', 'Washington D.C., District of Columbia, United States',
      'Remote - Washington D.C.', 'Washington, D.C. Metro Area', 'Washington, D.C., US', 'Maryland; Virginia; Washington, D.C.',
      'Remote, Maryland; Remote, Virginia; Remote, Washington D.C.', 'New York, N.Y. or Washington, D.C.']) {
      const r = resolveLocation(loc, idx);
      expect(r.places, loc).toContain('washington|DC');
      expect(r.states, loc).not.toContain('WA');
    }
    // ...while a real Washington-state place next to D.C. still counts.
    for (const loc of ['Bellevue, Washington; Chicago, Illinois; Washington, DC', 'San Francisco, CA | Seattle, WA | New York City, NY | Washington, DC',
      'Colorado, United States; Illinois, United States; Maryland, United States; Washington, District of Columbia, United States; Washington, United States']) {
      const r = resolveLocation(loc, idx);
      expect(r.places, loc).toContain('washington|DC');
      expect(r.states, loc).toContain('WA');
    }
    expect(places('Saint Louis, MO, United States')).toEqual(['st louis|MO']);
    expect(places('109 - Fort Worth, TX 76177')).toEqual(['ft worth|TX']);
  });

  it('tells same-name cities apart by state, and settles a bare name only when one state clearly has it', () => {
    expect(places('Portland, OR')).toEqual(['portland|OR']);
    expect(places('Portland, Maine, United States')).toEqual(['portland|ME']);
    expect(places('Portland')).toEqual(['portland|OR']);
    expect(places('Kansas City, MO')).toEqual(['kansas city|MO']);
    expect(places('Kansas City, KS')).toEqual(['kansas city|KS']);
    expect(places('York, PA')).toEqual(['york|PA']);
    expect(places('New York, NY')).toEqual(['new york|NY']);
    expect(places('Springfield')).toEqual([]);   // in many states, none dominant
  });

  it('does not read business names or longer place names as towns', () => {
    expect(places('Bay Point Golf Club - Panama City, FL 32408')).toEqual(['panama city|FL']);
    expect(places('Independence Hall - Billings, MT 59105')).toEqual(['billings|MT']);
    expect(places('The Vincent - San Rafael, CA 94903')).toEqual(['san rafael|CA']);
    expect(places('Trinity Place - Albemarle, NC 28001')).toEqual(['albemarle|NC']);
    expect(places('North Reading, MA, us')).not.toContain('reading|MA');
  });

  it('reads a state name as the state unless the location opens with it and the next part confirms the city', () => {
    expect(places('Florida')).toEqual([]);
    expect(places('Florida, Tallahassee, FL, United States')).toEqual(['tallahassee|FL']);
    expect(places('Florida, New York, United States')).toEqual(['florida|NY']);
    expect(places('Washington, PA 15301')).toEqual(['washington|PA']);
    expect(places('Indiana, PA, US')).toEqual(['indiana|PA']);
    expect(places('Albany, New York')).toEqual(['albany|NY']);
    expect(places('Remote - Alabama ; Remote - Alaska ; Remote - Florida')).toEqual([]);
  });

  it('keeps every place in a list', () => {
    expect(places('San Diego, California, United States; San Francisco, California, United States')).toEqual(['san diego|CA', 'san francisco|CA']);
    expect(places('Dallas / Fort Worth Area - Dallas, TX')).toEqual(['dallas|TX', 'ft worth|TX']);
  });

  it('leaves places outside the US and countries alone', () => {
    for (const loc of ['United States', 'USA', 'London, United Kingdom', 'Bengaluru, Karnataka, India', 'Toronto, ON, Canada', '']) {
      expect(places(loc), loc).toEqual([]);
    }
  });
});

describe('keys', () => {
  it('stores places, their states and remote', () => {
    expect(locationKeys('Seattle, WA', idx).sort()).toEqual(['seattle|WA', 'state|WA']);
    expect(locationKeys('Remote - USA', idx)).toEqual(['remote']);
  });

  it('turns a picked place into the key the filter matches', () => {
    expect(pickedKey('Seattle, WA')).toBe('seattle|WA');
    expect(pickedKey('St. Louis, MO')).toBe('st louis|MO');
    expect(pickedKey('WA')).toBe('state|WA');
    expect(pickedKey('Washington')).toBe('state|WA');
    expect(pickedKey('Washington, DC')).toBe('washington|DC');
    expect(pickedKey('NYC')).toBe('new york|NY');
    expect(pickedKey('Remote')).toBe('remote');
    expect(pickedKey('all')).toBeNull();
    expect(pickedKey('s')).toBeNull();
  });
});

describe('found in the sample review, round 2', () => {
  it('takes the state written right after each city in a list', () => {
    expect(places('Atlanta, Georgia, USA; Boston, Massachusetts, USA; New York, New York, USA')).toEqual(['atlanta|GA', 'boston|MA', 'new york|NY']);
    expect(places('Kansas City Barry Branch - Kansas City, MO 64153; Overland Park, KS')).toEqual(['kansas city|MO', 'overland park|KS']);
  });
  it('leaves foreign places alone', () => {
    expect(places('Healesville, Victoria, Australia')).toEqual([]);
    expect(places('Mandeville, Manchester Parish, Jamaica, 12, Jamaica')).toEqual([]);
    expect(places('London, Ontario, Canada')).toEqual([]);
  });
});

describe('found in the sample review, round 3', () => {
  it('reads a Canadian province as outside the US, and Ontario, CA as California', () => {
    expect(places('Greater Sudbury, Ontario')).toEqual([]);
    expect(places('Ontario Hub - Ontario, CA 91761')).toEqual(['ontario|CA']);
    expect(places('Ontario, California, United States')).toEqual(['ontario|CA']);
  });
});

describe('found checking prod, lists of bare city names', () => {
  it('resolves each city in a list without states', () => {
    expect(places('San Francisco, Seattle, New York')).toEqual(['new york|NY', 'san francisco|CA', 'seattle|WA']);
    expect(places('Austin | Chicago | New York City | Salt Lake City | San Francisco')).toEqual(['austin|TX', 'chicago|IL', 'new york|NY', 'salt lake city|UT', 'san francisco|CA']);
    expect(places('Austin or New York (Hybrid)')).toEqual(['austin|TX', 'new york|NY']);
    expect(places('NYC, SF, Seattle, US')).toEqual(['new york|NY', 'san francisco|CA', 'seattle|WA']);
  });
  it('still reads a state written after a city as that city\'s state', () => {
    expect(places('Albany, New York')).toEqual(['albany|NY']);
    expect(places('Seattle, Washington, United States')).toEqual(['seattle|WA']);
    expect(places('Austinburg, OH, United States')).toEqual(['austinburg|OH']);
    expect(places('Hialeah, CA')).toEqual([]);   // no Hialeah in California: not the Florida one either
  });
});

describe('neighborhoods', () => {
  it('reads a name before a borough as part of that city', () => {
    expect(places('Williamsburg, Brooklyn')).toEqual(['new york|NY']);
    expect(places('Ridgewood, Queens, United States')).toEqual(['new york|NY']);
  });
});

describe('found in the sample review, round 4', () => {
  it('does not read a word inside a longer name as a town elsewhere', () => {
    expect(places('Lynn Branch - Lynn, MA 01905')).toEqual(['lynn|MA']);
    expect(places('Montana Billings Sage - Billings, MT 59102')).toEqual(['billings|MT']);
    expect(places('Atlanta, Georgia, USA | USA-ND-Home Office | USA-KS-Home Office')).toEqual(['atlanta|GA']);
  });
  it('reads ", OR" as Oregon and " OR " between names as or', () => {
    expect(places('St. Louis, MO | Portland, OR | Fort Worth, TX')).toEqual(['ft worth|TX', 'portland|OR', 'st louis|MO']);
    expect(places('Austin OR Chicago OR Miami')).toEqual(['austin|TX', 'chicago|IL', 'miami|FL']);
  });
});

describe('found in the sample review, round 5', () => {
  it('names merged city-county governments by their city', () => {
    expect(places('Lexington, Kentucky, United States | Nicholasville, Kentucky, United States')).toEqual(['lexington|KY', 'nicholasville|KY']);
    expect(places('Macon, GA')).toEqual(['macon|GA']);
  });
  it('reads a part that runs two places together as a label when another part names the place', () => {
    expect(places('Austin Burnet 019 - Austin, TX 78757')).toEqual(['austin|TX']);
    expect(places('Seattle-Tacoma, WA')).toEqual(['seattle|WA', 'tacoma|WA']);   // the only part: both places
  });
});

describe('found in the sample review, round 6', () => {
  it('reads a part starting with a street number as an address', () => {
    expect(places('900 Winston - HOUSTON, TX 77009')).toEqual(['houston|TX']);
    expect(places('120 & 220 Bend, Vineyard, UT')).toEqual(['vineyard|UT']);
    expect(places('7324 Yohne Road, Fort Wayne, IN, USA')).toEqual(['ft wayne|IN']);
  });
  it('takes a state code written before the name in the same part', () => {
    expect(places('Orlando | US-CA-Van Nuys | US-NV-Las Vegas, FL, US')).toEqual(['las vegas|NV', 'orlando|FL']);
  });
});
