/**
 * Capacity signals graded against docs/scaling-strategy.md section 5.
 * The inputs below are prod's real numbers on 2026-10-08 unless noted.
 */
import { describe, it, expect } from 'vitest';
import { evaluateSignals, overallLevel, type CapacityInput } from '../server/services/admin-console.service';

const prod: CapacityInput = {
  feedP95Ms: 6625, feedSamples: 3, dbConnections: 7, maxConnections: 60,
  memAvailableMb: null, load1: null, cpus: null, diskPct: 53,
  activeJobs: 156_411, embeddingBacklog: 657, failingPipelines: 0, healthCheckAgeMin: 12,
};
const level = (i: CapacityInput, key: string) => evaluateSignals(i).find(s => s.key === key)!.level;

describe('evaluateSignals', () => {
  it('grades prod today: embedding backlog red, the rest healthy or not measured', () => {
    expect(level(prod, 'embeddingBacklog')).toBe('red');
    expect(level(prod, 'dbConnections')).toBe('green');
    expect(level(prod, 'disk')).toBe('green');
    expect(level(prod, 'activeJobs')).toBe('green');
    expect(level(prod, 'healthCheck')).toBe('green');
    // Not deployed yet on prod: RAM, load and CPUs.
    expect(level(prod, 'ramFree')).toBe('unknown');
    expect(level(prod, 'cpuLoad')).toBe('unknown');
    expect(overallLevel(evaluateSignals(prod))).toBe('red');
  });

  it('does not grade a feed p95 measured on fewer than 5 requests', () => {
    expect(level(prod, 'feedP95')).toBe('unknown');
    expect(evaluateSignals(prod).find(s => s.key === 'feedP95')!.display).toMatch(/only 3 requests/);
    expect(level({ ...prod, feedSamples: 40 }, 'feedP95')).toBe('red');
  });

  it('uses the strategy thresholds at the boundaries', () => {
    expect(level({ ...prod, feedSamples: 40, feedP95Ms: 499 }, 'feedP95')).toBe('green');
    expect(level({ ...prod, feedSamples: 40, feedP95Ms: 500 }, 'feedP95')).toBe('amber');
    expect(level({ ...prod, feedSamples: 40, feedP95Ms: 2000 }, 'feedP95')).toBe('red');
    expect(level({ ...prod, dbConnections: 41 }, 'dbConnections')).toBe('red');
    expect(level({ ...prod, memAvailableMb: 450 }, 'ramFree')).toBe('green');
    expect(level({ ...prod, memAvailableMb: 300 }, 'ramFree')).toBe('amber');
    expect(level({ ...prod, memAvailableMb: 150 }, 'ramFree')).toBe('red');
    expect(level({ ...prod, load1: 3.2, cpus: 2 }, 'cpuLoad')).toBe('red');
    expect(level({ ...prod, load1: 1.0, cpus: 2 }, 'cpuLoad')).toBe('green');
    expect(level({ ...prod, diskPct: 86 }, 'disk')).toBe('red');
    expect(level({ ...prod, activeJobs: 250_000 }, 'activeJobs')).toBe('red');
    expect(level({ ...prod, embeddingBacklog: 49 }, 'embeddingBacklog')).toBe('green');
  });

  it('treats a silent health check as red', () => {
    expect(level({ ...prod, healthCheckAgeMin: null }, 'healthCheck')).toBe('red');
    expect(level({ ...prod, healthCheckAgeMin: 90 }, 'healthCheck')).toBe('red');
  });

  it('ignores unknowns when rolling up', () => {
    const allUnknown = evaluateSignals({ ...prod, feedP95Ms: null, dbConnections: null, diskPct: null, activeJobs: null, embeddingBacklog: null, failingPipelines: null })
      .filter(s => s.key !== 'healthCheck');
    expect(overallLevel(allUnknown)).toBe('unknown');
  });
});
