/**
 * The rules (non-AI) resume parser runs when every AI provider has failed, so
 * its output is what a user sees on a bad day. Measured 2026-10-03 on real
 * candidates (scripts/eval-rules-parser.ts): a quarter of its positions carried
 * a whole paragraph, a phone number or a section heading in the title or
 * employer, and dateless or letter-spaced layouts lost jobs entirely.
 *
 * Cases below are anonymized versions of those real layouts.
 */
import { describe, it, expect } from 'vitest';
import { repairPositions, parseResumeWithIntelligence } from '../server/skill-intelligence';
import { AIResumeParser } from '../server/ai-resume-parser';

const pos = (title: string, company = '') => ({ title, company, duration: '', responsibilities: [] as string[] });
const show = (ps: { title: string; company: string }[]) => ps.map(p => `${p.title} @ ${p.company}`);
const parseFlat = (text: string) => {
  const parser = new AIResumeParser() as unknown as { normalizeFlattenedText(t: string): string };
  return parseResumeWithIntelligence(parser.normalizeFlattenedText(text)).positions;
};

describe('repairPositions', () => {
  it('strips contact details and stacked section headings', () => {
    expect(show(repairPositions([
      pos('Account Manager', 'PROFESSIONAL EXPERIENCE Star Security Agency'),
      pos('Senior Front End Developer', 'Jane Roe +65 8154 5106 jane@example.com WORK EXPERIENCE'),
    ]))).toEqual([
      'Account Manager @ Star Security Agency',
      'Senior Front End Developer @ Jane Roe',
    ]);
  });

  it('cuts a responsibility sentence off the employer', () => {
    expect(show(repairPositions([
      pos('Livelihoods Counsellor', 'Seefar Foundation, Returnee Project, Kabul, Manage daily operational workflow of the hub, delivering reintegration pathways.'),
    // stripLocation also peels the short "Returnee Project, Kabul" tail.
    ]))).toEqual(['Livelihoods Counsellor @ Seefar Foundation']);
  });

  it('keeps the last role phrase of a title that swallowed a paragraph', () => {
    const [p] = repairPositions([pos('Jane Roe Network Support Technician Seattle WA Skills Summary Experience Dedicated IT professional with 4+ years in network operations Amazon Technical Support Associate II Everett')]);
    expect(p.title).toBe('Amazon Technical Support Associate II');
  });

  it('rejoins a title split at "&"', () => {
    expect(show(repairPositions([pos('LIVELIHOOD OFFICER', '& BUSINESS TRAINER (REINTEGRATION)')])))
      .toEqual(['LIVELIHOOD OFFICER & BUSINESS TRAINER (REINTEGRATION) @ ']);
  });

  it('splits "Employer. Title. (dates)" in any language', () => {
    expect(show(repairPositions([pos('Companhia Siderúrgica Nacional. Técnico de Manutenção Elétrica. (04/1998 á 05/2008)')])))
      .toEqual(['Técnico de Manutenção Elétrica @ Companhia Siderúrgica Nacional']);
  });

  it('drops descriptions, languages and schools posing as titles', () => {
    expect(repairPositions([
      pos('Full-stack delivery: building and maintaining web apps'),
      pos('WORK EXPERIENCE SKILLS English'),
      pos('Universidade Católica de Petrópolis', 'UCP'),
      pos('#HRJ#eac80eab-dc04-4ba0-9c1f'),
    ])).toEqual([]);
  });

  it('keeps the same title at two employers, merges it when one has none', () => {
    expect(show(repairPositions([
      pos('Support Engineer', 'TECKpert'),
      pos('Support Engineer', 'YUPRO (META)'),
      pos('Front End Developer'),
      pos('Front End Developer', 'Pro Web'),
    ]))).toEqual([
      'Support Engineer @ TECKpert',
      'Support Engineer @ YUPRO (META)',
      'Front End Developer @ Pro Web',
    ]);
  });
});

describe('position extraction on flattened PDF layouts', () => {
  it('finds dateless "Employer — Title" jobs even when one dated job exists', () => {
    const text = 'PROFESSIONAL EXPERIENCE\nStar Security Agency — Account Manager 2021 - Present\n• Managed client accounts for 40 sites\n'
      + 'Silver Cloud Inn — Front Desk Agent / Night Auditor\n• Checked in guests and balanced nightly reports\n'
      + '• Prepared conference rooms and supported hotel operations Quality Food Center — Courtesy Clerk\n• Assisted with checkout and customer service';
    const titles = parseResumeWithIntelligence(text).positions.map(p => p.title);
    expect(titles).toEqual(expect.arrayContaining(['Front Desk Agent / Night Auditor', 'Courtesy Clerk']));
  });

  it('reads letter-spaced dates', () => {
    const flat = 'JANE ROE Front End Developer W O R K E X P E R I E N C E A p r 2 0 2 2 - F e b 2 0 2 5 Pro Web Senior Front End Developer '
      + '• Built responsive interfaces with React and TypeScript for client dashboards and internal tools '
      + 'J a n 2 0 2 0 - M a r 2 0 2 2 Golden Owl Solutions React Developer • Shipped component library used by six product teams';
    const titles = parseFlat(flat).map(p => p.title);
    expect(titles.some(t => /Senior Front End Developer/.test(t))).toBe(true);
  });
});
