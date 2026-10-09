/**
 * Data helpers behind the admin console's Growth, Jobs and AI & matching tabs.
 */
import { describe, it, expect } from 'vitest';
import { lastDays, fillDays, weekOverWeek, vendorName, groupSources, engineOf, isAiEngine, isRulesEngine, BEFORE_TRACKING } from '../server/services/admin-insights.service';

const now = new Date('2026-10-09T15:00:00Z');

describe('daily series', () => {
  it('lists the last N UTC days, oldest first, ending today', () => {
    expect(lastDays(3, now)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
  });

  it('fills days with no rows as 0, so the chart has no gaps', () => {
    const s = fillDays([{ day: '2026-10-08T00:00:00Z', n: '4' }, { day: new Date('2026-10-06T00:00:00Z'), n: 2 }], 5, now);
    expect(s.map(p => p.value)).toEqual([0, 2, 0, 4, 0]);
    expect(s).toHaveLength(5);
  });

  it('compares the last 7 days with the 7 before', () => {
    const s = fillDays([], 14, now).map((p, i) => ({ ...p, value: i < 7 ? 1 : 3 }));
    expect(weekOverWeek(s)).toEqual({ thisWeek: 21, priorWeek: 7 });
  });
});

describe('hiring systems', () => {
  it('treats "ATS:greenhouse" and "greenhouse" as one vendor', () => {
    expect(vendorName('ATS:greenhouse')).toBe('Greenhouse');
    expect(vendorName('greenhouse')).toBe('Greenhouse');
    expect(vendorName('ATS:smartrecruiters')).toBe('SmartRecruiters');
    expect(vendorName(null)).toBe('Unknown');
    expect(vendorName('newvendor')).toBe('Newvendor');
  });

  it('groups by vendor, largest first, and folds the tail into Other', () => {
    // Real mix from prod on 2026-10-09 (top of it).
    const g = groupSources([
      { source: 'ATS:greenhouse', n: 73261 }, { source: 'greenhouse', n: 1102 }, { source: 'ATS:lever', n: 21442 },
      { source: 'ATS:ashby', n: 17008 }, { source: 'ashby', n: 1536 }, { source: 'Adzuna', n: 3782 }, { source: 'JSearch', n: 186 },
    ], 3);
    expect(g).toEqual([
      { label: 'Greenhouse', value: 74363 }, { label: 'Lever', value: 21442 }, { label: 'Ashby', value: 18544 }, { label: 'Other', value: 3968 },
    ]);
  });
});

describe('who read a resume', () => {
  it('names the AI provider when recorded, else the engine', () => {
    expect(engineOf({ aiProvider: 'gemini-lite', extractor: 'ai-text' })).toBe('Gemini Flash-Lite');
    expect(engineOf({ extractor: 'ai-text' })).toBe('AI (before provider tracking)');
    expect(engineOf({ extractor: 'rules' })).toBe('Rule engine (no AI)');
    expect(engineOf(null)).toBe('Not parsed');
    // Parsed before the engine was recorded: read, engine unknown. Not "not parsed" (the bug this replaces).
    expect(engineOf({ status: 'completed' })).toBe(BEFORE_TRACKING);
    expect(engineOf({ status: 'failed' })).toBe('Parse failed');
  });

  it('counts only real AI reads as AI', () => {
    expect(isAiEngine('Groq')).toBe(true);
    expect(isAiEngine('Gemini (read the PDF)')).toBe(true);
    expect(isAiEngine('Rule engine (no AI)')).toBe(false);
    expect(isAiEngine('Not parsed')).toBe(false);
    // Unknown engine counts as neither AI nor rules.
    expect(isAiEngine(BEFORE_TRACKING)).toBe(false);
    expect(isRulesEngine(BEFORE_TRACKING)).toBe(false);
    expect(isRulesEngine('Rule engine (no AI)')).toBe(true);
  });
});
