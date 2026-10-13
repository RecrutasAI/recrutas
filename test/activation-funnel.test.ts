/**
 * The Phase 1 activation funnel (gtm-plan A3): PostHog's ordered funnel, real accounts only.
 * Numbers below are PostHog's real answer for the last 90 days on 2026-10-13.
 */
import { describe, it, expect } from 'vitest';
import { activationFunnelQuery, activationSteps, ACTIVATION_STEPS } from '../server/services/admin-insights.service';

const real = ['94592c0d-223a-4f08-9889-36b67ef783b7', '4d001988-45b3-42a3-9ad2-fec0aa4ac8f4'];

describe('activationFunnelQuery', () => {
  it('asks for the four steps in order, within 30 days of sign-up', () => {
    const q: any = activationFunnelQuery(real, 90);
    expect(q.kind).toBe('FunnelsQuery');
    expect(q.series.map((s: any) => s.event)).toEqual(ACTIVATION_STEPS.map(s => s.event));
    expect(q.funnelsFilter).toMatchObject({ funnelOrderType: 'ordered', funnelWindowInterval: 30, funnelWindowIntervalUnit: 'day' });
    expect(q.dateRange.date_from).toBe('-90d');
  });
  it('counts only the given real accounts, and lets nothing but user ids into the query', () => {
    const q: any = activationFunnelQuery([...real, "x') OR 1=1 --", ''], 30);
    expect(q.properties[0].key).toBe(`distinct_id IN ('${real[0]}', '${real[1]}')`);
    expect(activationFunnelQuery([], 30).properties[0].key).toBe("distinct_id IN ('')");   // no real accounts: nobody
  });
});

describe('activationSteps', () => {
  const posthog = [
    { name: 'signup_completed', count: 13, average_conversion_time: null },
    { name: 'resume_uploaded', count: 7, average_conversion_time: 37.3 },
    { name: 'job_feed_viewed', count: 7, average_conversion_time: 76.7 },
    { name: 'auto_apply_filled', count: 1, average_conversion_time: 7200 },
  ];
  it('gives conversion from the step before and from sign-up', () => {
    const s = activationSteps(posthog);
    expect(s.map(x => x.people)).toEqual([13, 7, 7, 1]);
    expect(s.map(x => x.fromPrevious)).toEqual([null, 53.8, 100, 14.3]);
    expect(s.map(x => x.fromStart)).toEqual([null, 53.8, 53.8, 7.7]);
    expect(s[3].avgHoursFromPrevious).toBe(2);
    expect(s[2].avgHoursFromPrevious).toBeCloseTo(1 / 60);  // 77 s → 1 min
    expect(activationSteps([{ count: 2 }, { count: 1, average_conversion_time: 300 }])[1].avgHoursFromPrevious! * 60).toBeCloseTo(5);  // not 6
    expect(s[0].label).toBe('Signed up');
  });
  it('never divides by zero', () => {
    expect(activationSteps([{ count: 0 }, { count: 0 }, { count: 0 }, { count: 0 }]).every(x => x.fromPrevious === null || x.fromPrevious === 0)).toBe(true);
    expect(activationSteps([]).map(x => x.people)).toEqual([0, 0, 0, 0]);
  });
});
