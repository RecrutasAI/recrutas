/**
 * A candidate's first and last name from whatever we have, in order of trust:
 * what they typed (profile, then account row), their sign-in account (email
 * sign-up stores first_name/last_name; Google stores full_name/name), then the
 * name their resume states. Never the email address: this name goes on the
 * resume file recruiters receive ("First_Last_resume.pdf").
 */
export interface PersonName { firstName: string; lastName: string }

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const looksLikeEmail = (s: string) => s.includes('@');

export function splitFullName(full: unknown): PersonName | null {
  const s = clean(full);
  if (!s || looksLikeEmail(s)) {return null;}
  const parts = s.split(' ');
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function pair(first: unknown, last: unknown): PersonName | null {
  const f = clean(first);
  if (!f || looksLikeEmail(f)) {return null;}
  return { firstName: f, lastName: clean(last) };
}

export function resolveCandidateName(src: {
  profile?: { firstName?: unknown; lastName?: unknown } | null;
  user?: { firstName?: unknown; lastName?: unknown } | null;
  authMetadata?: Record<string, unknown> | null;
  resumeName?: unknown;
}): PersonName | null {
  const md = src.authMetadata || {};
  return pair(src.profile?.firstName, src.profile?.lastName)
    ?? pair(src.user?.firstName, src.user?.lastName)
    ?? pair(md.first_name, md.last_name)
    ?? splitFullName(md.full_name)
    ?? splitFullName(md.name)
    ?? splitFullName(src.resumeName);
}

/** "First Last" for display, from Supabase user metadata; null when there's no name. */
export function displayNameFromMetadata(md: Record<string, unknown> | null | undefined): string | null {
  const n = resolveCandidateName({ authMetadata: md });
  return n ? `${n.firstName} ${n.lastName}`.trim() : null;
}
