/**
 * The feed's location filter: a city matches however the post writes it; a chosen state only
 * drops jobs that name a different state.
 */
import { describe, it, expect } from 'vitest';
import { locationMatches, parseLocationFilter } from '../shared/location-filter';

const matches = (filter: string, location: string | null) => locationMatches(location, parseLocationFilter(filter));

describe('parseLocationFilter', () => {
  it('reads city, state, state-only and remote', () => {
    expect(parseLocationFilter('Seattle, WA')).toEqual({ city: 'seattle', state: 'WA' });
    expect(parseLocationFilter('seattle')).toEqual({ city: 'seattle' });
    expect(parseLocationFilter('WA')).toEqual({ state: 'WA' });
    expect(parseLocationFilter('Washington')).toEqual({ state: 'WA' });
    expect(parseLocationFilter('Washington, DC')).toEqual({ city: 'washington', state: 'DC' });
    expect(parseLocationFilter('Remote')).toEqual({ remote: true });
    expect(parseLocationFilter('all')).toBeNull();
  });
});

describe('locationMatches', () => {
  it('finds Seattle however the post writes it', () => {
    for (const loc of ['Seattle, WA', 'Onsite - Seattle', 'Seattle', 'Greater Seattle Area', 'Seattle-Tacoma, WA',
      'Hybrid (Seattle, Washington)', 'SEATTLE WA', 'Seattle, WA, United States', 'Remote or Seattle']) {
      expect(matches('Seattle, WA', loc), loc).toBe(true);
      expect(matches('Seattle', loc), loc).toBe(true);
    }
  });

  it('does not match other cities or the same name in another state', () => {
    expect(matches('Seattle, WA', 'Tacoma, WA')).toBe(false);
    expect(matches('Seattle, WA', 'Seattleville, OH')).toBe(false);
    expect(matches('Portland, OR', 'Portland, ME')).toBe(false);
    expect(matches('Portland, OR', 'Portland, Maine')).toBe(false);
    expect(matches('Portland, OR', 'Portland, OR')).toBe(true);
    expect(matches('Portland, OR', 'Portland')).toBe(true);                 // no state named: keep it
  });

  it('never reads the words "or" and "in" as states', () => {
    expect(matches('Portland, OR', 'Portland or Remote')).toBe(true);
    expect(matches('Indianapolis, IN', 'Office in Indianapolis')).toBe(true);
  });

  it('handles cities that contain a state name', () => {
    expect(matches('Washington, DC', 'Washington, DC')).toBe(true);
    expect(matches('Washington, DC', 'Washington, D.C.')).toBe(true);
    expect(matches('Kansas City, MO', 'Kansas City, MO')).toBe(true);
    expect(matches('Kansas City, MO', 'Kansas City, KS')).toBe(false);
    expect(matches('Charleston, WV', 'Charleston, West Virginia')).toBe(true);
    expect(matches('Richmond, VA', 'Richmond, Virginia')).toBe(true);
    expect(matches('Richmond, VA', 'Richmond, CA')).toBe(false);
    expect(matches('New York, NY', 'New York, NY')).toBe(true);
    expect(matches('St. Louis, MO', 'St Louis, MO')).toBe(true);
  });

  it('filters by state alone and by remote', () => {
    expect(matches('WA', 'Seattle, WA')).toBe(true);
    expect(matches('Washington', 'Spokane, Washington')).toBe(true);
    expect(matches('WA', 'Portland, OR')).toBe(false);
    expect(matches('WA', 'Remote')).toBe(false);
    expect(matches('Remote', 'Remote - US')).toBe(true);
    expect(matches('Remote', 'Seattle, WA')).toBe(false);
  });
});
