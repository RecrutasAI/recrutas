/**
 * The feed's "Level" filter: a job's level read from its title, and whether it passes a picked
 * level. One definition for the direct feed (client) and third-party jobs (server), so both
 * filter the same way.
 */
export type ExperienceLevel = 'entry' | 'mid' | 'senior' | 'lead' | 'executive';

export const EXPERIENCE_LEVELS: readonly ExperienceLevel[] = ['entry', 'mid', 'senior', 'lead', 'executive'];

export function inferJobLevel(title: string): ExperienceLevel {
  const t = (title || '').toLowerCase();
  if (/director|vp|vice president|head of|chief|cto|ceo/i.test(t)) {return 'executive';}
  if (/lead|manager|principal/i.test(t)) {return 'lead';}
  if (/senior|sr\.|staff/i.test(t)) {return 'senior';}
  if (/junior|entry|intern|associate|new grad/i.test(t)) {return 'entry';}
  return 'mid';
}

/** Entry level also takes mid: many entry jobs don't say "junior" in the title. */
export function levelMatches(title: string, picked: ExperienceLevel): boolean {
  const level = inferJobLevel(title);
  return picked === 'entry' ? level === 'entry' || level === 'mid' : level === picked;
}
