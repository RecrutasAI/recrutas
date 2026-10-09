/**
 * Capacity signals graded against docs/scaling-strategy.md section 5.
 * The inputs below are prod's real numbers on 2026-10-08 unless noted.
 */
import { describe, it, expect } from 'vitest';
import { evaluateSignals, overallLevel, type CapacityInput } from '../server/services/admin-console.service';

const prod: CapacityInput = {
  feedP95Ms: 6625, feedSamples: 3, dbConnections: 7, maxConnections: 60,
  memAvailableMb: null, load1: null, cpus: null, diskPct: 53,
  activeJobs: 156_411, embeddingBacklog: 657, embeddingOldestMin: 15 * 60, failingPipelines: 0, healthCheckAgeMin: 12,
};
const level = (i: CapacityInput, key: string) => evaluateSignals(i).find(s => s.key === key)!.level;

describe('evaluateSignals', () => {
  it('grades prod today: the matching backlog red (oldest 15 h), the rest healthy or not measured', () => {
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

describe('AI parse health (the "pay for AI" trigger)', () => {
  const parse = (parses7d: number, parsesOnRules7d: number, signups7d = 3) =>
    evaluateSignals({ ...prod, parses7d, parsesOnRules7d, signups7d }).find(s => s.key === 'aiParse')!;

  it('grades the share of recent résumés still on the rule engine', () => {
    expect(parse(12, 1).level).toBe('green');   // prod on 2026-10-08: 11 AI, 1 rules
    expect(parse(20, 3).level).toBe('amber');
    expect(parse(20, 6).level).toBe('red');
  });

  it('does not judge on fewer than 5 parses', () => {
    expect(parse(3, 3).level).toBe('unknown');
    expect(parse(3, 3).display).toMatch(/too few/);
  });

  it('says stay free without an influx, and only says pay with one', () => {
    expect(parse(20, 10, 3).playbook).toMatch(/stay free/);
    expect(parse(20, 10, 3).actions.some(a => a.kind === 'decision')).toBe(false);
    // With an influx, paying shows as a decision (with its price), never a button.
    expect(parse(200, 100, 80).actions.find(a => a.kind === 'decision')?.label).toMatch(/"pay" trigger/);
  });
});

describe('signals you can act on (2026-10-09)', () => {
  const sig = (i: CapacityInput, key: string) => evaluateSignals(i).find(s => s.key === key)!;

  it('grades the matching backlog by how long the oldest job has waited, not how many wait', () => {
    // 2,000 waiting 5 h into a 6-hourly cycle is normal (the false alarm this replaces).
    expect(sig({ ...prod, embeddingBacklog: 2000, embeddingOldestMin: 5 * 60 }, 'embeddingBacklog').level).toBe('green');
    expect(sig({ ...prod, embeddingBacklog: 40, embeddingOldestMin: 9 * 60 }, 'embeddingBacklog').level).toBe('amber');
    expect(sig({ ...prod, embeddingBacklog: 40, embeddingOldestMin: 15 * 60 }, 'embeddingBacklog').level).toBe('red');
    expect(sig({ ...prod, embeddingBacklog: 0, embeddingOldestMin: null }, 'embeddingBacklog')).toMatchObject({ level: 'green', display: 'none waiting' });
    expect(sig({ ...prod, embeddingBacklog: 845, embeddingOldestMin: 200 }, 'embeddingBacklog').display).toBe('845 waiting · oldest 3.3 h');
  });

  it('offers a button that fixes it, not advice', () => {
    expect(sig(prod, 'embeddingBacklog').actions).toEqual([{ kind: 'run', job: 'batch-embeddings', label: 'Match new jobs now' }]);
    expect(sig(prod, 'healthCheck').actions[0]).toMatchObject({ kind: 'run', job: 'vps-db-health' });
    expect(sig(prod, 'dbConnections').actions.map(a => a.kind)).toEqual(['setting', 'setting']);
    for (const s of evaluateSignals(prod)) {expect(s.playbook).not.toMatch(/\bask\b|SSH in|Open Pipelines/i);}
  });

  it('names failing jobs and offers to run each again', () => {
    const s = sig({ ...prod, failingPipelines: 2, failingPipelineNames: ['scrape-ats', 'db-backup'] }, 'failingPipelines');
    expect(s.display).toBe('scrape-ats, db-backup');
    // db-backup can't be run from the console (unsafe twice); scrape-ats maps to its job.
    expect(s.actions).toEqual([{ kind: 'run', job: 'scrape-ats-jobs', label: 'Run "Scrape company job boards" again' }]);
  });

  it('shows money as a decision, never a button', () => {
    const decisions = evaluateSignals(prod).flatMap(s => s.actions).filter(a => a.kind === 'decision');
    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {expect(d).not.toHaveProperty('job');}
    expect(sig({ ...prod, parses7d: 200, parsesOnRules7d: 100, signups7d: 3 }, 'aiParse').actions.map(a => a.kind)).toEqual(['run']);
    expect(sig({ ...prod, parses7d: 200, parsesOnRules7d: 100, signups7d: 80 }, 'aiParse').actions.map(a => a.kind)).toEqual(['run', 'decision']);
  });

  it('leaves a snoozed signal out of the overall status', () => {
    const signals = evaluateSignals({ ...prod, healthCheckAgeMin: 5 });
    expect(overallLevel(signals)).toBe('red');
    expect(overallLevel(signals.map(s => (s.key === 'embeddingBacklog' ? { ...s, snoozedUntil: '2099-01-01T00:00:00Z' } : s)))).toBe('green');
  });
});
