import { describe, it, expect } from 'vitest';
import { resolveCandidateName, splitFullName, displayNameFromMetadata } from '../server/lib/candidate-name';

describe('candidate name for the resume file', () => {
  it('prefers what the candidate typed, then the account, then sign-in, then the resume', () => {
    expect(resolveCandidateName({ profile: { firstName: 'Ana', lastName: 'Lee' }, authMetadata: { full_name: 'X Y' } })).toEqual({ firstName: 'Ana', lastName: 'Lee' });
    expect(resolveCandidateName({ profile: { firstName: ' ' }, user: { firstName: 'Bo', lastName: null } })).toEqual({ firstName: 'Bo', lastName: '' });
    expect(resolveCandidateName({ authMetadata: { first_name: 'Cy', last_name: 'Diaz' } })).toEqual({ firstName: 'Cy', lastName: 'Diaz' });
    expect(resolveCandidateName({ authMetadata: { full_name: 'Dee  Van der Berg', email: 'd@x.com' } })).toEqual({ firstName: 'Dee', lastName: 'Van der Berg' });
    expect(resolveCandidateName({ authMetadata: { name: 'Eve Ng' } })).toEqual({ firstName: 'Eve', lastName: 'Ng' });
    expect(resolveCandidateName({ resumeName: 'Fay Ito' })).toEqual({ firstName: 'Fay', lastName: 'Ito' });
  });

  it('never uses an email address as a name', () => {
    expect(resolveCandidateName({ authMetadata: { full_name: 'jane@gmail.com' } })).toBeNull();
    expect(resolveCandidateName({ user: { firstName: 'jane@gmail.com' } })).toBeNull();
    expect(splitFullName('a@b.co')).toBeNull();
    expect(displayNameFromMetadata({ email: 'a@b.co' })).toBeNull();
    expect(displayNameFromMetadata({ full_name: 'Gus Hale' })).toBe('Gus Hale');
  });

  it('returns null when nothing names the person', () => {
    expect(resolveCandidateName({})).toBeNull();
    expect(resolveCandidateName({ profile: { firstName: '' }, authMetadata: {} })).toBeNull();
  });
});

describe('resume file name (mirrors the extension)', () => {
  it('names the file after the person, by file type', async () => {
    const { resumeFileName } = await import('../server/lib/candidate-name');
    expect(resumeFileName({ firstName: 'José', lastName: 'Ñúñez' }, 'application/pdf')).toBe('Jose_Nunez_resume.pdf');
    expect(resumeFileName({ firstName: 'Jane', lastName: '' }, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('Jane_resume.docx');
    expect(resumeFileName(null, 'application/msword')).toBe('Resume.doc');
    expect(resumeFileName(null, null)).toBe('Resume.pdf');
  });
});
