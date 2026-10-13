/**
 * The activation funnel follows each person in order (gtm-plan A3); see
 * orderedSteps in server/services/admin-insights.service.ts.
 */
import { describe, expect, it } from 'vitest';
import { orderedSteps, ACTIVATION_STEPS, type PersonTimes } from '../server/services/admin-insights.service';

const T0 = new Date('2026-10-01T12:00:00Z').getTime();
const at = (min: number) => new Date(T0 + min * 60_000);
const person = (p: Partial<PersonTimes>): PersonTimes => ({ signup: at(0), resume: null, feeds: [], autofills: [], ...p });

describe('orderedSteps', () => {
  it('counts the same people, in order', () => {
    const s = orderedSteps([
      person({ resume: at(2), feeds: [at(3)], autofills: [at(63)] }),   // activated
      person({ resume: at(1), feeds: [at(2)] }),                         // stopped at feed
      person({ resume: at(5) }),                                         // stopped at resume
      person({}),                                                        // signed up only
    ]);
    expect(s.map(x => x.label)).toEqual(ACTIVATION_STEPS.map(x => x.label));
    expect(s.map(x => x.people)).toEqual([4, 3, 2, 1]);
    expect(s.map(x => x.fromPrevious)).toEqual([null, 75, 66.7, 50]);
    expect(s.map(x => x.fromStart)).toEqual([null, 75, 50, 25]);
    expect(s[3].avgHoursFromPrevious).toBe(1);                // 60 min after the feed
    expect(s[1].avgHoursFromPrevious! * 60).toBeCloseTo(3);   // (2 + 1 + 5) / 3 ≈ 2.7 → 3 min
  });

  it('needs each step after the one before', () => {
    // Autofill before ever opening the feed doesn't count; a feed view only before the resume doesn't either.
    const s = orderedSteps([
      person({ resume: at(10), feeds: [at(5), at(20)], autofills: [at(15)] }),
      person({ resume: at(10), feeds: [at(5)] }),
    ]);
    expect(s.map(x => x.people)).toEqual([2, 2, 1, 0]);
  });

  it('only within 30 days of signing up', () => {
    const s = orderedSteps([person({ resume: at(1), feeds: [at(31 * 24 * 60)] })]);
    expect(s.map(x => x.people)).toEqual([1, 1, 0, 0]);
  });

  it('no sign-ups: zeros, no division by zero', () => {
    const s = orderedSteps([]);
    expect(s.map(x => x.people)).toEqual([0, 0, 0, 0]);
    expect(s.every(x => x.fromPrevious === null && x.avgHoursFromPrevious === null)).toBe(true);
  });
});
