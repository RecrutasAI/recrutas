/**
 * A stable identity for a posting on a company's ATS board.
 *
 * Scraped ATS jobs used to be keyed on their URL. Greenhouse lets companies
 * host the board on their own site, and when one does, every absolute_url
 * changes at once (ionq: job-boards.greenhouse.io/ionq/jobs/6107289004 →
 * ionq.com/job?gh_jid=6107289004). Keyed on URL, each posting came back as a
 * new job — ionq's 121 openings were in the feed three times — and the old
 * rows looked like a board-wide purge, which snapshot expiry's mass-drop guard
 * refuses to close.
 *
 * Every vendor's posting URL carries the vendor's own job id (Greenhouse keeps
 * it in gh_jid on custom domains), and that id survives URL changes. Measured
 * 2026-10-02: the patterns below parse 264,648 of 264,648 stored ATS rows.
 * The id alone is not unique across companies (4 collisions), so the key is
 * scoped to the company the scraper writes.
 */
const VENDOR_ID_PATTERNS: Record<string, RegExp[]> = {
  greenhouse: [/[?&]gh_jid=(\d+)/, /greenhouse\.io\/[^/]+\/jobs\/(\d+)/],
  lever: [/jobs\.lever\.co\/[^/]+\/([0-9a-f-]{36})/i],
  ashby: [/jobs\.ashbyhq\.com\/[^/]+\/([0-9a-f-]{36})/i],
  smartrecruiters: [/smartrecruiters\.com\/[^/]+\/(\d+)/],
  breezy: [/\.breezy\.hr\/p\/([0-9a-f]{12})/i],
  workable: [/\/j\/([0-9A-Za-z]+)/],
  recruitee: [/recruitee\.com\/o\/([^/?#]+)/],
};

/** 'ATS:greenhouse' or 'greenhouse' → 'greenhouse'. */
function vendorOf(source: string): string {
  return source.replace(/^ATS:/i, '').toLowerCase();
}

/** The vendor's job id in a posting URL, or null if the URL doesn't carry one. */
export function vendorJobId(source: string, url: string | null | undefined): string | null {
  if (!url) {return null;}
  for (const re of VENDOR_ID_PATTERNS[vendorOf(source)] ?? []) {
    const m = url.match(re);
    if (m) {return m[1].toLowerCase();}
  }
  return null;
}

/**
 * external_id for a scraped ATS posting: `<company>::<vendor job id>`, or the
 * URL itself when no id can be read from it (the old behaviour, so an
 * unrecognised URL shape degrades to URL identity instead of colliding).
 */
export function atsJobKey(source: string, company: string, url: string): string {
  const id = vendorJobId(source, url);
  return id ? `${company}::${id}` : url;
}
