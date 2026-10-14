/**
 * Skills read from job text: real skills in any occupation, never everyday words.
 * Cases taken from live postings (2026-10-14): 'Compensation Analysis' was on 42,738 jobs,
 * 'Go' on 13,629, 'C' on 4,202 and 'React Native' on nursing jobs that say "RN".
 */
import { describe, expect, it } from 'vitest';
import { extractSkillsFromText } from '../server/utils/skill-extractor';

const has = (text: string) => extractSkillsFromText(text);

describe('extractSkillsFromText on prose', () => {
  it('a nursing posting: clinical skills, not React Native', () => {
    const s = has('Registered Nurse (RN) for our telemetry unit. BLS certified and ACLS required. Experience with Epic EMR, patient care, triage and wound care. Competitive compensation.');
    expect(s).toEqual(expect.arrayContaining(['ACLS', 'Epic', 'Electronic Medical Records', 'Patient Care', 'Triage', 'Wound Care', 'BLS Certified']));
    expect(s).not.toContain('React Native');
    expect(s).not.toContain('Compensation Analysis');
  });

  it('everyday words are not skills; the same words as names are', () => {
    expect(has('You will go above and beyond in a lean, fast team. Next steps: we rest on weekends.')).toEqual([]);
    expect(has('Backend services in Go; Lean Six Sigma; Spring Boot; Microsoft Excel and Word.'))
      .toEqual(expect.arrayContaining(['Go', 'Lean', 'Spring', 'Excel']));
  });

  it('single letters never count; names with symbols do', () => {
    const s = has('Grade C license. R&D team. Plan B. Strong C++ and C# and .NET experience.');
    expect(s).not.toContain('C');
    expect(s).not.toContain('R');
    expect(s).toEqual(expect.arrayContaining(['C++', 'C#', '.NET']));
  });

  it('trades and teaching skills match as written', () => {
    expect(has('Journeyman electrician: welding, blueprint reading, OSHA compliance, forklift operation.'))
      .toEqual(expect.arrayContaining(['Welding', 'Blueprint Reading', 'OSHA Compliance', 'Forklift Operation']));
    expect(has('Teacher: lesson planning, classroom management and curriculum development.'))
      .toEqual(expect.arrayContaining(['Lesson Planning', 'Classroom Management', 'Curriculum Development']));
  });

  it('acronyms count in capitals; an ambiguous one (RN) never maps to a tech skill', () => {
    expect(has('ML platform, UX research, QA automation and IT support.')).toEqual(expect.arrayContaining(['Machine Learning', 'UX Design']));
    expect(has('Hiring an RN; RN license required.')).not.toContain('React Native');
  });

  it('tech postings still read fully', () => {
    expect(has('Python, AWS, Kubernetes, PostgreSQL, React and TypeScript; k8s experience a plus.'))
      .toEqual(expect.arrayContaining(['Python', 'AWS', 'Kubernetes', 'PostgreSQL', 'React', 'TypeScript']));
  });
});

import { skillsMentioned } from '../server/utils/skill-extractor';

describe('skillsMentioned: the candidate\'s own skills in a posting', () => {
  const nurse = ['Telemetry', 'IV Therapy', 'Patient Assessment', 'Epic', 'Communication', 'ACLS', 'Charge Nurse'];
  const posting = 'Telemetry RN. Start IVs and manage IV therapy, complete patient assessments, chart in Epic. ACLS required. Strong communication.';

  it('finds any occupation\'s skills without a list, skips soft skills', () => {
    expect(skillsMentioned(posting, nurse)).toEqual(['Telemetry', 'IV Therapy', 'Patient Assessment', 'Epic', 'ACLS']);  // plural 'assessments' too
  });

  it('a developer\'s "Go" doesn\'t match the word go; "Git" matches as written', () => {
    expect(skillsMentioned('You will go far here and use git daily.', ['Go', 'Git'])).toEqual(['Git']);
    expect(skillsMentioned('Services written in Go.', ['Go'])).toEqual(['Go']);
  });

  it('an acronym counts only in capitals', () => {
    expect(skillsMentioned('we are on a mission', ['MIS'])).toEqual([]);
    expect(skillsMentioned('Knowledge of SQL and EHR systems', ['SQL', 'EHR'])).toEqual(['SQL', 'EHR']);
  });
});
