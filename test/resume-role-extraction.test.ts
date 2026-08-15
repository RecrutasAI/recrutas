/**
 * Role-extraction corpus for the deterministic résumé parser.
 *
 * Why this exists: skills extraction was well covered, but job TITLES were not,
 * and the title is load-bearing — `positions[0]` becomes the candidate's profile
 * headline ("{title} at {company}") and the titles are compared against job
 * postings during matching. A wrong title is visible to the user on the first
 * screen after upload.
 *
 * The corpus deliberately spans layouts rather than repeating one shape, because
 * the bug this was written for only appears in some of them: a location line
 * sitting between the company and the date pushed the title outside the parser's
 * two-line lookback, so the company name was stored as the job title.
 *
 * Matching is fuzzy (case-insensitive substring) on purpose. We assert the role
 * was *identified*, not that it was reproduced byte-for-byte — trailing commas
 * and seniority suffixes are noise for both the headline and matching.
 */
import { parseResumeWithIntelligence } from '../server/skill-intelligence';

type Case = {
  name: string;
  text: string;
  expectTitles: string[];
  /** Companies to assert, aligned with expectTitles by index. `null` = don't care. */
  expectCompanies?: (string | null)[];
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

const CASES: Case[] = [
  {
    name: 'classic: Title / Company / Date / bullets',
    expectTitles: ['Senior Software Engineer', 'Software Engineer'],
    expectCompanies: ['Stripe', 'Airbnb'],
    text: `John Doe
john@example.com | (555) 123-4567

EXPERIENCE

Senior Software Engineer
Stripe, San Francisco, CA
Jan 2021 – Present
• Led migration of payments infra to Kubernetes
• Mentored 4 junior engineers

Software Engineer
Airbnb
2018 – 2021
• Built listing search features in React and Go

EDUCATION
BS Computer Science, UC Berkeley, 2018

SKILLS
Python, Go, React, Kubernetes, PostgreSQL`,
  },
  {
    name: 'company-first: Company [tab] Date / Title / bullets',
    expectTitles: ['Data Engineer', 'Analytics Intern'],
    expectCompanies: ['Netflix', 'Hulu'],
    text: `Jane Smith
jane@x.io

WORK EXPERIENCE

Netflix\t\tMar 2022 – Present
Data Engineer
• Built Spark pipelines processing 2TB daily
• Owned the metrics warehouse

Hulu\t\tJun 2020 – Feb 2022
Analytics Intern
• Wrote SQL dashboards for content team

SKILLS: Spark, SQL, Python, Airflow`,
  },
  {
    name: 'inline pipes: Title | Company | Date',
    expectTitles: ['Product Manager', 'Associate Product Manager'],
    expectCompanies: ['Figma', 'Dropbox'],
    text: `Alex Rivera
alex@mail.com

EXPERIENCE
Product Manager | Figma | 2022 – Present
• Shipped multiplayer editing improvements
• Ran discovery with 40+ customers
Associate Product Manager | Dropbox | 2019 – 2022
• Owned sharing-flow experiments

SKILLS: Roadmapping, SQL, Figma, A/B testing`,
  },
  {
    name: 'title+date inline, company on next line',
    expectTitles: ['DevOps Engineer'],
    text: `Sam Lee

EXPERIENCE

DevOps Engineer  2020 – Present
Cloudflare
• Ran the edge deployment pipeline
• Cut deploy time from 40m to 8m

SKILLS: Terraform, AWS, Go`,
  },
  {
    name: 'ALL-CAPS company + location flattened (Walmart style)',
    expectTitles: ['Programmer Analyst'],
    expectCompanies: ['WALMART'],
    text: `Maria Garcia
maria@mail.com
PROFESSIONAL EXPERIENCE
WALMART, INC., Bentonville, Arkansas Programmer Analyst 2016 – 2020
• Developed inventory reconciliation batch jobs in Java
• Supported nightly ETL runs
EDUCATION
BS Information Systems, University of Arkansas`,
  },
  {
    name: 'dateless: Company — Title with bullets',
    expectTitles: ['Frontend Developer'],
    expectCompanies: ['Shopify'],
    text: `Chris Wong

EXPERIENCE
Shopify — Frontend Developer
• Built checkout UI components in React
• Improved Lighthouse scores from 60 to 95

SKILLS: React, TypeScript, CSS`,
  },
  {
    name: 'non-tech: nursing',
    expectTitles: ['Registered Nurse', 'Licensed Practical Nurse'],
    text: `Dawn Brooks, RN

EXPERIENCE

Registered Nurse
Northwestern Memorial Hospital, Chicago, IL
May 2019 – Present
• Provided direct patient care in a 32-bed med-surg unit
• Precepted new graduate nurses

Licensed Practical Nurse
Rush Oak Park Hospital
2016 – 2019
• Administered medications and monitored vitals

LICENSES: RN (IL), BLS, ACLS`,
  },
  {
    name: 'titles needing role-word coverage (Scrum Master / Growth Marketer)',
    expectTitles: ['Scrum Master', 'Growth Marketer'],
    text: `Taylor Kim

EXPERIENCE

Scrum Master
Atlassian
2021 – Present
• Facilitated ceremonies for 3 squads
• Coached teams on estimation

Growth Marketer
Canva
2018 – 2021
• Ran paid acquisition across Meta and Google

SKILLS: Jira, SQL, Looker`,
  },
  {
    name: 'numeric dates 03/2021 - 06/2023',
    expectTitles: ['Backend Developer'],
    expectCompanies: ['Careem'],
    text: `Omar Hassan

WORK HISTORY

Backend Developer
Careem
03/2021 - 06/2023
• Built ride-pricing services in Node.js

SKILLS: Node.js, Redis, MySQL`,
  },
  {
    name: 'title with comma specialization',
    expectTitles: ['Manager, Data Engineering'],
    expectCompanies: ['Spotify'],
    text: `Lisa Park

EXPERIENCE

Manager, Data Engineering
Spotify
2020 – Present
• Led a team of 7 data engineers
• Owned the event ingestion platform

SKILLS: Scala, Kafka, GCP`,
  },
  {
    name: 'month-name dates + Remote modifier',
    expectTitles: ['Customer Support Representative'],
    expectCompanies: ['Zapier'],
    text: `Diego Alvarez

EXPERIENCE

Customer Support Representative
Zapier, Remote
March 2022 – Present
• Handled 60+ tickets weekly at 98% CSAT

SKILLS: Zendesk, SQL`,
  },

  // ── Regression cases: these are the layouts that were broken ──────────────

  {
    // Reconstructed from prod candidate_users id=2, which stored
    // title="II Everett," company="WA". The location line between company and
    // date pushed the title out of a 2-line lookback.
    name: 'REGRESSION: Title / Company / Location / Date (4-line block)',
    expectTitles: ['Technical Support Associate II'],
    expectCompanies: ['Amazon'],
    text: `Priya Nair

EXPERIENCE

Technical Support Associate II
Amazon
Everett, WA
August 2021 – Present
• Resolved escalated device and account issues
• Maintained 95% CSAT across 40+ contacts daily

SKILLS: Zendesk, Troubleshooting`,
  },
  {
    name: 'REGRESSION: word date separator "2019 to 2022"',
    expectTitles: ['QA Engineer'],
    expectCompanies: ['Booking.com'],
    text: `Nina Petrova

EXPERIENCE

QA Engineer
Booking.com
2019 to 2022
• Automated regression suites in Cypress

SKILLS: Cypress, Selenium, JavaScript`,
  },
  {
    name: 'REGRESSION: promotion chain under one company header',
    expectTitles: ['Senior Accountant', 'Staff Accountant'],
    text: `Robert Chen, CPA

EXPERIENCE

Deloitte, New York, NY

Senior Accountant
Jul 2021 – Present
• Managed audits for 8 mid-market clients

Staff Accountant
Aug 2018 – Jun 2021
• Prepared workpapers and reconciliations

CERTIFICATIONS: CPA`,
  },
];

describe('résumé role extraction (deterministic parser)', () => {
  for (const c of CASES) {
    it(`extracts roles — ${c.name}`, () => {
      const positions = parseResumeWithIntelligence(c.text).positions;
      const got = positions.map(p => ({ title: p.title, company: p.company }));
      const shown = JSON.stringify(got);

      // Assert by INDEX, not by search. Titles overlap as substrings
      // ("Software Engineer" ⊂ "Senior Software Engineer"), so a find-based
      // assertion silently matches the wrong row and hides ordering bugs.
      // Résumés list most-recent-first and positions[0] becomes the headline,
      // so order is part of the contract.
      c.expectTitles.forEach((want, idx) => {
        const actual = positions[idx];
        expect(
          (actual && norm(actual.title).includes(norm(want))) ||
            `position[${idx}]: expected title containing "${want}", got ${shown}`,
        ).toBe(true);
      });

      c.expectCompanies?.forEach((wantCo, idx) => {
        if (!wantCo) return;
        const actual = positions[idx];
        expect(
          (actual && norm(actual.company).includes(norm(wantCo))) ||
            `position[${idx}]: expected company containing "${wantCo}", got ${shown}`,
        ).toBe(true);
      });
    });
  }

  it('never stores a bare date as a job title', () => {
    // Flattened single-line PDF text. We do not require perfect parsing here —
    // only that the parser refuses to emit garbage, because a date stored as a
    // title becomes the user's profile headline.
    const blob = `Priya Patel priya@mail.com Summary Experienced ML practitioner. Experience Machine Learning Engineer Scale AI Feb 2022 – Present • Built labeling quality models Data Scientist Crypto-Express Thailand 2019 – Jan 2022 • Built fraud detection models Skills Python, PyTorch, SQL`;
    const positions = parseResumeWithIntelligence(blob).positions;
    const DATE_LIKE = /^(present|current|now|\d{4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{0,4})[,.\s]*$/i;
    for (const p of positions) {
      expect(
        !DATE_LIKE.test(p.title.trim()) ||
          `date-like string stored as title: ${JSON.stringify(p)}`,
      ).toBe(true);
    }
  });
});
