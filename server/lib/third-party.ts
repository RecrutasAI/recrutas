/**
 * Third-party listings: jobs not posted by the employer itself.
 *
 * The product promise is that the main feed is direct from the company. Everything else is
 * kept, labeled, and shown only when a person has no direct matches (instead of "0 matches"):
 *   - job boards and aggregators (Adzuna, Indeed…), by source;
 *   - staffing agencies, recruiters and firms placing contractors at clients, by company name.
 *     They run real hiring-system boards, so source and link look direct; only the name tells.
 *     Curated by hand: a phrase rule ("our client") flagged real employers like AECOM and
 *     Stantec and missed agencies like KRG (measured on the Fleet, 2026-10-11).
 * Names are matched lowercase.
 */

export type ThirdPartyKind = 'agency' | 'job_board';

export const AGGREGATOR_SOURCES = new Set(['Adzuna', 'JSearch', 'Jooble', 'Indeed', 'ArbeitNow', 'USAJobs', 'RemoteOK', 'WeWorkRemotely', 'The Muse']);

export const THIRD_PARTY_COMPANIES = new Set([
  // Marketplaces and recruiters (2026-09)
  'jobgether',              // remote-work marketplace relisting other companies' roles
  'nexthire',
  'bluelight consulting',   // 1,138 postings across only 17 titles, all in client language
  'crisp recruit',
  'seasoned recruitment',
  'talent software services',
  'horizontal talent',
  'jobs for humanity', 'jobsforhumanity',  // job platform posting partner employers' roles
  // Staffing agencies and contractor-placement firms found in the Fleet (2026-10-11)
  'collabera', 'mindlance', 'aerotek', 'aerotek commercial staffing', 'actalent services', 'teksystems',
  'allegis group jobs', 'allegis global solutions', 'surge staffing', 'hudson manpower', 'aurora staffing',
  'integrated resources inc', 'integratedresourcesinc',   // 75% of postings say "our client"
  'krg technology inc', 'krgtechnologyinc',
  'alphabe insight inc', 'alphabeinsightinc',
  'sonoma consulting inc.', 'sonomaconsultinginc',
  'cloudnexa.com', 'cloudnexacom',
  'openings at salesdraft recruiting', 'app recruitment', 'mra recruiting services', 'premiere hcstaffing',
  '#twiceasnice recruiting', 'openreqstaffing', 'connect talent solutions', 'dm estate staffing',
  'tmc workforce solutions inc', 'windrose staffing', 'levelonepersonnel', 'ascendstaffing',
  'teach me personnel llc', 'resourceful talent group', 'colorado network staffing inc',
  'partners personnel - management resources llc', 'virtual staffing solutions', 'fitt talent partners',
  '10-4 truck recruiting', 'mthree recruiting portal',
]);

export function thirdPartyKind(job: { source?: string | null; company?: string | null }): ThirdPartyKind | null {
  if (job.source && AGGREGATOR_SOURCES.has(job.source)) {return 'job_board';}
  if (job.company && THIRD_PARTY_COMPANIES.has(job.company.trim().toLowerCase())) {return 'agency';}
  return null;
}
