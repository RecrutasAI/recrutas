/**
 * Candidates whose job titles map to no role family used to be scored as a role
 * MISMATCH against every classified job, so the no-role-match cap held every
 * job under the 30% feed floor and the feed fell back to generic 0% roles.
 * 3 of 11 real candidates with titles hit it (2026-10-03), e.g. "Programmer
 * Analyst", "Eletricista de Manutenção", "Livelihood Officer & Business Trainer".
 */
import { describe, it, expect } from 'vitest';
import { scoreJob, getRoleTitleKeywords } from '../server/job-scorer';

const FEED_FLOOR = 30;
const sweSkills = ['JavaScript', 'React', 'Node.js', 'Express.js', 'SQL', 'Docker', 'Java', 'Spring'];
const sweJob = {
  title: 'Software Engineer II',
  skills: ['JavaScript', 'React', 'Node.js', 'TypeScript', 'SQL'],
  description: 'Build web services in Node.js and React.',
};
// Cosine distance 0.25 = similarity 0.75, a typical strong semantic match.
const STRONG_SEMANTIC = 0.25;

describe('unclassified candidate titles', () => {
  it('no longer cap a clear skill + semantic match under the feed floor', () => {
    const s = scoreJob(sweSkills, 'mid', sweJob, undefined, ['Call Center Engineering Team Lead Analyst'], undefined, STRONG_SEMANTIC);
    expect(s.matchScore).toBeGreaterThanOrEqual(FEED_FLOOR);
  });

  it('score the same as a candidate with no titles at all', () => {
    const none = scoreJob(sweSkills, 'mid', sweJob, undefined, [], undefined, STRONG_SEMANTIC);
    const unclassified = scoreJob(sweSkills, 'mid', sweJob, undefined, ['Livelihood Officer & Business Trainer'], undefined, STRONG_SEMANTIC);
    expect(unclassified.components.titleScore).toBe(none.components.titleScore);
    expect(unclassified.matchScore).toBe(none.matchScore);
  });

  it('still lets a literal title overlap score above neutral', () => {
    const job = { title: 'Eletricista de Manutenção', skills: [], description: '' };
    const s = scoreJob([], 'mid', job, undefined, ['Eletricista de Manutenção'], undefined, STRONG_SEMANTIC);
    expect(s.components.titleScore).toBeGreaterThan(50);
  });
});

describe('"Programmer Analyst" is a software role', () => {
  it('classifies for retrieval', () => {
    expect(getRoleTitleKeywords(['Programmer Analyst, Call Center Engineering Team']).length).toBeGreaterThan(0);
  });

  it('matches a software engineer job above the floor', () => {
    const s = scoreJob(sweSkills, 'mid', sweJob, undefined, ['Programmer Analyst, Call Center Engineering Team'], undefined, STRONG_SEMANTIC);
    expect(s.matchScore).toBeGreaterThanOrEqual(FEED_FLOOR);
  });

  it('does not pull in manufacturing CNC / PLC programmers', () => {
    expect(getRoleTitleKeywords(['CNC Programmer'])).toEqual([]);
    expect(getRoleTitleKeywords(['PLC Programmer'])).toEqual([]);
  });
});

describe('a known career mismatch is still capped', () => {
  it('keeps a nursing job under the floor for a classified software engineer', () => {
    const nurseJob = { title: 'Registered Nurse, RN - Home Health', skills: ['Patient Care', 'SQL'], description: '' };
    const s = scoreJob(sweSkills, 'mid', nurseJob, undefined, ['Software Engineer'], undefined, STRONG_SEMANTIC);
    expect(s.matchScore).toBeLessThan(FEED_FLOOR);
  });
});
