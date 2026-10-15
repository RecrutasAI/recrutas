import { describe, it, expect } from 'vitest';
import { plainDashes } from '../server/lib/plain-dashes';

describe('plainDashes', () => {
  it('turns AI-style em dashes into commas', () => {
    expect(plainDashes('I led the migration — cutting costs by 30% — in six months.')).toBe('I led the migration, cutting costs by 30%, in six months.');
    expect(plainDashes('Reliable—and fast.')).toBe('Reliable, and fast.');
  });
  it('keeps number ranges as hyphens', () => {
    expect(plainDashes('5–10 years')).toBe('5-10 years');
    expect(plainDashes('$90k — $120k')).toBe('$90k, $120k');  // not both numbers at the dash: a comma
    expect(plainDashes('2019 – 2023')).toBe('2019-2023');
  });
  it('leaves ordinary hyphens and plain text alone', () => {
    expect(plainDashes('Full-time, sign-up flow')).toBe('Full-time, sign-up flow');
    expect(plainDashes('Ends with a dash —')).toBe('Ends with a dash');
  });
});
