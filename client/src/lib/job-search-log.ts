/**
 * Job-search log entries for unemployment claims, from the applications
 * Recrutas tracked. Fields follow Washington ESD's job-search log
 * (EMS 10313, "Employer contacts"): contact date, job title, employer, how
 * the contact was made, type of contact, and employer contact information.
 *
 * Only facts Recrutas has are filled in. Address and phone stay blank for the
 * claimant to complete: the log is a legal record and guessing would be wrong.
 * A claim week runs Sunday through Saturday ("week ending" Saturday).
 */
export const REQUIRED_PER_WEEK = 3;

export interface LoggableApplication {
  appliedAt: string;
  job: { title: string; company: string; location?: string | null; externalUrl?: string | null };
}

export interface LogEntry {
  contactDate: string;   // MM/DD/YYYY
  jobTitle: string;
  employer: string;
  method: 'Online';
  contactType: 'Application/resume';
  city: string;
  state: string;
  website: string;
}

/** Sunday 00:00 through the next Sunday 00:00 (exclusive), in local time, for the week containing `d`. */
export function claimWeek(d: Date): { start: Date; end: Date; weekEnding: Date } {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  const weekEnding = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return { start, end, weekEnding };
}

export const mmddyyyy = (d: Date): string =>
  `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

const US_STATE = /^(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])$/;

/** "Seattle, WA" -> { city: 'Seattle', state: 'WA' }. Remote, multi-city or unknown -> blanks. */
export function cityState(location?: string | null): { city: string; state: string } {
  const loc = (location || '').trim();
  if (!loc || /;|\bremote\b|\bmultiple\b|\band\b/i.test(loc)) {return { city: '', state: '' };}
  const parts = loc.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2 && US_STATE.test(parts[1].toUpperCase())) {return { city: parts[0], state: parts[1].toUpperCase() };}
  return { city: '', state: '' };
}

export function logEntriesForWeek(apps: LoggableApplication[], weekOf: Date): LogEntry[] {
  const { start, end } = claimWeek(weekOf);
  return apps
    .filter(a => { const t = new Date(a.appliedAt); return t >= start && t < end; })
    .sort((a, b) => new Date(a.appliedAt).getTime() - new Date(b.appliedAt).getTime())
    .map(a => {
      const { city, state } = cityState(a.job.location);
      return {
        contactDate: mmddyyyy(new Date(a.appliedAt)),
        jobTitle: a.job.title.trim(),
        employer: a.job.company.trim(),
        method: 'Online' as const,
        contactType: 'Application/resume' as const,
        city, state,
        website: a.job.externalUrl || '',
      };
    });
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function logToCsv(entries: LogEntry[], weekEnding: Date): string {
  const header = ['Week ending', 'Contact date', 'Activity', 'Job title', 'Employer', 'How contacted', 'Type of contact', 'Address', 'City', 'State', 'Website or email', 'Phone'];
  const rows = entries.map(e => [mmddyyyy(weekEnding), e.contactDate, 'Employer contact', e.jobTitle, e.employer, e.method, e.contactType, '', e.city, e.state, e.website, '']);
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
