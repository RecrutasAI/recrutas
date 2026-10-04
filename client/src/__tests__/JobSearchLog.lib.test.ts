import { describe, it, expect } from 'vitest';
import { claimWeek, cityState, logEntriesForWeek, logToCsv, mmddyyyy } from '@/lib/job-search-log';

describe('job-search log', () => {
  it('uses Sunday-to-Saturday claim weeks', () => {
    const { start, weekEnding } = claimWeek(new Date(2026, 9, 7)); // Wed Oct 7 2026
    expect(mmddyyyy(start)).toBe('10/04/2026');      // Sunday
    expect(mmddyyyy(weekEnding)).toBe('10/10/2026'); // Saturday
  });

  it('fills city and state only when the location is a single US city', () => {
    expect(cityState('Seattle, WA')).toEqual({ city: 'Seattle', state: 'WA' });
    expect(cityState('Remote')).toEqual({ city: '', state: '' });
    expect(cityState('New York City, NY; San Francisco, CA')).toEqual({ city: '', state: '' });
    expect(cityState('London, United Kingdom')).toEqual({ city: '', state: '' });
  });

  it('lists the week\'s applications in date order and leaves unknowns blank', () => {
    const apps = [
      { appliedAt: new Date(2026, 9, 8, 15).toISOString(), job: { title: 'Help Desk', company: 'PubMatic', location: 'Remote', externalUrl: 'https://x/2' } },
      { appliedAt: new Date(2026, 9, 5, 9).toISOString(), job: { title: 'Support Engineer ', company: 'Acme, Inc.', location: 'Seattle, WA', externalUrl: 'https://x/1' } },
      { appliedAt: new Date(2026, 9, 11, 9).toISOString(), job: { title: 'Next week', company: 'Later', location: null } },
    ];
    const entries = logEntriesForWeek(apps, new Date(2026, 9, 7));
    expect(entries.map(e => e.employer)).toEqual(['Acme, Inc.', 'PubMatic']);
    expect(entries[0]).toMatchObject({ contactDate: '10/05/2026', jobTitle: 'Support Engineer', method: 'Online', contactType: 'Application/resume', city: 'Seattle', state: 'WA' });
    const csv = logToCsv(entries, claimWeek(new Date(2026, 9, 7)).weekEnding).split('\n');
    expect(csv[0]).toBe('Week ending,Contact date,Activity,Job title,Employer,How contacted,Type of contact,Address,City,State,Website or email,Phone');
    expect(csv[1]).toBe('10/10/2026,10/05/2026,Employer contact,Support Engineer,"Acme, Inc.",Online,Application/resume,,Seattle,WA,https://x/1,');
  });
});
