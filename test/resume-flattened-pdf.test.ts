/**
 * Guard for flattened-PDF résumé text.
 *
 * Why this exists: `unpdf`'s `extractText(pdf, { mergePages: true })` — the
 * extractor the upload path actually uses — returns the entire document as a
 * SINGLE line. Zero newlines, one space between every token, and section
 * headings letter-spaced by the PDF renderer ("E D U C A T I O N").
 *
 * Every rule in the deterministic fallback splits on '\n', so before
 * normalizeFlattenedText() the fallback saw one 3000-character line and found
 * no sections at all. That matters only when the AI providers are unavailable
 * (quota exhaustion), which is exactly when nobody is watching.
 *
 * The existing role-extraction corpus does NOT cover this: every case there is
 * newline-rich, a layout real PDFs never produce.
 */
import { describe, it, expect } from 'vitest';
import { AIResumeParser } from '../server/ai-resume-parser';

// Shape mirrors real unpdf output: no newlines, letter-spaced headings.
const FLAT = 'FIRST LAST San Francisco, California 94109 | first@example.com '
  + 'S U M M A R Y An analytical software engineer with broad experience. '
  + 'E D U C A T I O N UNIVERSITY OF ARIZONA, Tucson, Arizona '
  + 'M.S., Computer Science, 2012 B.S.B.A., Management Information Systems, 2011 '
  + 'T E C H N I C A L S K I L L S JavaScript, ReactJS, NodeJS, Python, Docker '
  + 'E X P E R I E N C E WALMART, INC., Bentonville, Arkansas '
  + 'Programmer Analyst, Call Center Engineering Team, 2011-2016 '
  + 'Architected financial services hotline app for 8 countries.';

const parser = new AIResumeParser();
const normalize = (t: string): string =>
  (parser as unknown as { normalizeFlattenedText(t: string): string }).normalizeFlattenedText(t);

describe('flattened-PDF text normalization', () => {
  it('reconstructs line breaks when the PDF gives us none', () => {
    expect((FLAT.match(/\n/g) || []).length).toBe(0);
    expect((normalize(FLAT).match(/\n/g) || []).length).toBeGreaterThan(5);
  });

  it('de-letter-spaces headings without eating the next word', () => {
    const out = normalize(FLAT);
    expect(out).toMatch(/^EDUCATION$/m);
    expect(out).toMatch(/UNIVERSITY OF ARIZONA/);
    // The bug this guards: "E D U C A T I O N UNIVERSITY" -> "EDUCATIONU".
    expect(out).not.toMatch(/EDUCATIONU/);
  });

  it('keeps multi-word job titles on one line', () => {
    expect(normalize(FLAT)).toMatch(/Programmer Analyst/);
  });

  it('leaves text that already has line structure untouched', () => {
    const structured = ['FIRST LAST', 'EXPERIENCE', 'Engineer, 2011-2016', 'x', 'y', 'z'].join('\n');
    expect(normalize(structured)).toBe(structured);
  });

  it('recovers education from a flattened résumé', async () => {
    const withFallback = parser as unknown as {
      extractWithFallback(t: string): Promise<{ education: unknown[] }>;
    };
    const result = await withFallback.extractWithFallback(FLAT);
    expect(result.education.length).toBeGreaterThan(0);
  });
});
