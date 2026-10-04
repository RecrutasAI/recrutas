import { describe, it, expect, vi } from 'vitest';
vi.mock('../server/db', () => ({ db: {} }));
import { diagnose, type DiagnosedApplication } from '../server/services/application-diagnosis.service';

const now = new Date('2026-10-04T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 864e5);
const app = (o: Partial<DiagnosedApplication> = {}): DiagnosedApplication => ({
  appliedAt: daysAgo(5), postedAt: daysAgo(7), company: 'acme', status: 'submitted',
  postingState: 'live', reposted: false, verdict: 'apply', verdictReason: 'You meet the stated requirements', companyMedianDays: null, ...o,
});

describe('diagnose', () => {
  it('waits for enough applications instead of guessing', () => {
    const d = diagnose([app(), app()], 12, now);
    expect(d.enoughData).toBe(false);
    expect(d.nextStep.kind).toBe('need_data');
    expect(d.findings).toEqual([]);
  });

  it('spots applying after postings usually come down', () => {
    // Applied 20-30 days after posting; postings at these companies last ~12 days.
    const apps = [app({ postedAt: daysAgo(35), appliedAt: daysAgo(10) }), app({ postedAt: daysAgo(30), appliedAt: daysAgo(8) }), app({ postedAt: daysAgo(25), appliedAt: daysAgo(4) })];
    const d = diagnose(apps, 12, now);
    expect(d.timing?.appliedLate).toBe(3);
    expect(d.nextStep.kind).toBe('apply_earlier');
    expect(d.findings.join(' ')).toContain('3 of 3 postings had been up longer');
  });

  it('uses a company\'s own lifetime when known', () => {
    // 10 days old is fine globally (12) but late for a company whose postings last 4.
    const apps = [1, 2, 3].map(() => app({ postedAt: daysAgo(15), appliedAt: daysAgo(5), companyMedianDays: 4 }));
    expect(diagnose(apps, 12, now).timing?.appliedLate).toBe(3);
    expect(diagnose(apps.map(a => ({ ...a, companyMedianDays: null })), 12, now).timing?.appliedLate).toBe(0);
  });

  it('spots applying to jobs the candidate does not meet', () => {
    const apps = [
      app({ verdict: 'skip', verdictReason: 'Requires an active Secret clearance' }),
      app({ verdict: 'skip', verdictReason: 'Requires an active Secret clearance' }),
      app({ verdict: 'stretch', verdictReason: 'Asks for 8+ years; you have about 4' }),
      app(),
    ];
    const d = diagnose(apps, 12, now);
    expect(d.fit).toEqual({ stretch: 1, skip: 2, topReason: 'Requires an active Secret clearance' });
    expect(d.nextStep.kind).toBe('better_fit');
  });

  it('suggests following up on live postings past two weeks', () => {
    const apps = [app({ appliedAt: daysAgo(20), postedAt: daysAgo(21) }), app({ appliedAt: daysAgo(16), postedAt: daysAgo(17) }), app({ appliedAt: daysAgo(3), postedAt: daysAgo(4) })];
    const d = diagnose(apps, 12, now);
    expect(d.answers.waitingPastFollowUp).toBe(2);
    expect(d.nextStep.kind).toBe('follow_up');
  });

  it('counts replies, take-downs and reposts separately', () => {
    const apps = [app({ status: 'rejected' }), app({ status: 'interview_scheduled' }), app({ postingState: 'taken_down' }), app({ postingState: 'taken_down', reposted: true })];
    const d = diagnose(apps, 12, now);
    expect(d.answers).toMatchObject({ replied: 2, takenDown: 1, reposted: 1, waiting: 0 });
    expect(d.findings[0]).toBe('2 of your 4 applications got a reply.');
  });

  it('says so when things look healthy', () => {
    expect(diagnose([app(), app(), app()], 12, now).nextStep.kind).toBe('keep_going');
  });
});
