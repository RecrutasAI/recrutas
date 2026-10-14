/**
 * "Why you match" is written for the candidate: the role they've held, the matching skills by
 * name, whether the level fits (in the right direction), and location. No scoring jargon.
 */
import { describe, expect, it } from 'vitest';
import { scoreJob } from '../server/job-scorer';

const nurseSkills = ['Epic', 'Telemetry', 'IV Therapy', 'Patient Assessment', 'Wound Care'];
const nurseTitles = ['Registered Nurse, Telemetry', 'Registered Nurse, Medical-Surgical'];

describe('match explanation', () => {
  it('names the past role and the matching skills', () => {
    const s = scoreJob(nurseSkills, 'mid', { title: 'Registered Nurse - Telemetry', skills: ['Epic', 'Telemetry', 'IV Therapy', 'Patient Assessment', 'BLS'] }, undefined, nurseTitles);
    expect(s.aiExplanation).toContain('Registered Nurse, Telemetry');
    expect(s.aiExplanation).toMatch(/Your skills it asks for: Epic, Telemetry, IV Therapy and 1 more/);
    expect(s.aiExplanation).not.toMatch(/direct \+|related skill matches|profile similarity|Strong role match/);
  });

  it('says a junior job is more junior than you, not "above your level"', () => {
    const s = scoreJob(['React', 'TypeScript'], 'executive', { title: 'Junior Frontend Developer', skills: ['React'] }, undefined, ['VP of Engineering']);
    // Over-qualified fits are only lightly penalized, so there may be no level line at all; it must
    // never call a more junior job a step up or "above your level".
    expect(s.aiExplanation).not.toMatch(/A step up|Slightly above your level/);
  });

  it('a step up reads as a step up', () => {
    const s = scoreJob(['React', 'TypeScript'], 'entry', { title: 'Principal Frontend Engineer', skills: ['React'] }, undefined, ['Junior Frontend Developer']);
    expect(s.aiExplanation).toContain('A step up from your experience');
  });

  it('a weak match says so plainly', () => {
    const s = scoreJob(['Excel'], 'mid', { title: 'Plumber', skills: ['Pipefitting'] }, undefined, ['Accountant']);
    expect(s.aiExplanation).not.toMatch(/worked as|skills it asks for|A step up|More junior/);
  });
});
