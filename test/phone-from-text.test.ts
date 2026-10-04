import { describe, it, expect } from 'vitest';
import { phoneFromText } from '../server/lib/phone';

// Autofill falls back to the phone in the resume text when the candidate never
// saved one (resume parses before 2026-10-04 dropped the parsed phone).
describe('phoneFromText', () => {
  it('finds common US formats', () => {
    expect(phoneFromText('Jane Roe  Seattle, WA  2065550142  jane@x.com')).toBe('2065550142');
    expect(phoneFromText('Phone: (206) 555-0142 | Email')).toBe('(206) 555-0142');
    expect(phoneFromText('+1 206.555.0142')).toBe('+1 206.555.0142');
  });

  it('ignores years, date ranges and long ids', () => {
    expect(phoneFromText('Amazon 2019-2023, Meta 2023-2025')).toBe('');
    expect(phoneFromText('Req 744000151423519 posted')).toBe('');
    expect(phoneFromText('')).toBe('');
    expect(phoneFromText(null)).toBe('');
  });
});
