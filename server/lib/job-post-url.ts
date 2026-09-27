/**
 * The "is this a real job-post page?" rule, in one place.
 *
 * It runs in three spots that used to each carry their own copy: the ingestion
 * chokepoint (JS), the drizzle feed query and the raw pgvector feed query
 * (both SQL). The copies drifted in the past, so the patterns live here as
 * strings that are valid both as JS RegExp source and as Postgres ARE regexes,
 * and every caller is built from them.
 *
 * A URL counts as a job post when it is not a bare domain root and carries a
 * job-id-like marker: ≥4 digits in the path/query, an ATS query param, a /job/
 * or /jobs/<long-slug> segment, or a known ATS job-post host.
 */

/** A domain root, with or without a query: https://acme.com, https://acme.com/.
 *  `[^/?#]` stops the host at a `?`, so https://careers.acme.com?gh_jid=123 is
 *  NOT a bare domain — Greenhouse emits exactly that shape for custom domains. */
export const BARE_DOMAIN_PATTERN = '^https?://[^/?#]+/?$';

/** A job id: 4+ consecutive digits in a path segment or the query. */
export const JOB_ID_PATTERN = '[/?][^/?#]*\\d{4,}';

/** ATS query params and job-post path segments (case-insensitive). */
export const JOB_MARKER_PATTERN = '(gh_jid|jobid|requisition|posting|/job/|/jobs/[a-z0-9_-]{8,})';

/** Known ATS job-post hosts (case-insensitive). Breezy post ids are 12 hex
 *  chars (`/p/308c999bbd6b-title`), which only pass the digit rule by luck —
 *  ~43% of Breezy postings were rejected before `.breezy.hr/p/` was added. */
export const ATS_HOST_PATTERN =
  '(boards\\.greenhouse\\.io|job-boards\\.greenhouse\\.io|jobs\\.lever\\.co|jobs\\.ashbyhq\\.com' +
  '|\\.recruitee\\.com|\\.workable\\.com|\\.bamboohr\\.com|myworkdayjobs\\.com|smartrecruiters\\.com' +
  '|icims\\.com|taleo\\.net|\\.breezy\\.hr/p/)';

const bareDomainRe = new RegExp(BARE_DOMAIN_PATTERN);
const jobIdRe = new RegExp(JOB_ID_PATTERN);
const jobMarkerRe = new RegExp(JOB_MARKER_PATTERN, 'i');
const atsHostRe = new RegExp(ATS_HOST_PATTERN, 'i');

export function isJobPostUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (bareDomainRe.test(url)) return false;
  return jobIdRe.test(url) || jobMarkerRe.test(url) || atsHostRe.test(url);
}

const lit = (pattern: string): string => {
  if (pattern.includes("'")) throw new Error('job-post URL pattern must not contain a quote');
  return `'${pattern}'`;
};

/**
 * The same rule as a SQL boolean expression over `column` (a trusted
 * identifier, never user input). Patterns are inlined as literals, not bound,
 * so the planner sees constants exactly as it did with the hand-written copies.
 */
export function jobPostUrlSqlCondition(column: string): string {
  return `(
    ${column} IS NOT NULL
    AND NOT (${column} ~ ${lit(BARE_DOMAIN_PATTERN)})
    AND (
      ${column} ~ ${lit(JOB_ID_PATTERN)}
      OR ${column} ~* ${lit(JOB_MARKER_PATTERN)}
      OR ${column} ~* ${lit(ATS_HOST_PATTERN)}
    )
  )`;
}
