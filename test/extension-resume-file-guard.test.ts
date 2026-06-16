/**
 * Guards the extension fill-form résumé-upload targeting: the résumé must only
 * attach to actual résumé/CV file fields, never to cover-letter / other-document
 * uploads. Regression test for the cover-letter mis-attachment bug.
 *
 * Run with: npx jest test/extension-resume-file-guard.test.ts
 */
import { isResumeFileField } from '../server/extension-fill-helpers';

describe('isResumeFileField — extension résumé upload targeting', () => {
  it('targets résumé/CV file fields', () => {
    expect(isResumeFileField({ id: 'resume', label: 'Resume/CV', name: 'resume' })).toBe(true);
    expect(isResumeFileField({ id: 'cv_upload', label: 'Upload your CV' })).toBe(true);
    // generic/unlabelled file field defaults to résumé (most common required upload)
    expect(isResumeFileField({ id: 's3_upload_123', label: 'Attach a file', name: '' })).toBe(true);
  });

  it('does NOT target cover-letter file fields (the reported bug)', () => {
    expect(isResumeFileField({ id: 'cover_letter', label: 'Cover Letter', name: 'cover_letter' })).toBe(false);
    expect(isResumeFileField({ id: 'x', label: 'Cover letter (optional)' })).toBe(false);
    expect(isResumeFileField({ id: 'coverLetter', label: '', name: 'coverletter' })).toBe(false);
  });

  it('does NOT target other document uploads', () => {
    expect(isResumeFileField({ label: 'Academic Transcript' })).toBe(false);
    expect(isResumeFileField({ label: 'Writing Sample' })).toBe(false);
    expect(isResumeFileField({ label: 'Portfolio' })).toBe(false);
    expect(isResumeFileField({ label: 'Headshot photo' })).toBe(false);
  });

  it('handles missing field defensively', () => {
    expect(isResumeFileField(undefined)).toBe(false);
  });

  it('replicates the post-filter over the real Adyen Greenhouse field set', () => {
    // The two file inputs observed on job-boards.greenhouse.io/adyen/jobs/8002490
    const fields = [
      { id: 'resume', label: 'Resume/CV', name: 'resume', type: 'file' },
      { id: 'cover_letter', label: 'Cover Letter', name: 'cover_letter', type: 'file' },
    ];
    const fieldsById = new Map(fields.map((f) => [f.id, f]));
    // AI/fallback emit upload_resume for both; the guard must drop cover_letter.
    let actions = [
      { fieldId: 'resume', action: 'upload_resume' },
      { fieldId: 'cover_letter', action: 'upload_resume' },
    ];
    actions = actions.filter(
      (a) => a.action !== 'upload_resume' || isResumeFileField(fieldsById.get(a.fieldId))
    );
    expect(actions.map((a) => a.fieldId)).toEqual(['resume']);
  });
});
