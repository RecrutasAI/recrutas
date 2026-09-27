/**
 * Snapshot expiry: close a job once its employer's board stops listing it.
 *
 * Age-based expiry (expireStaleJobs) keys on created_at, so a posting taken
 * down two days after we ingested it stayed in the feed for ~13 more days.
 * Each ATS scrape already reads the whole board, so after a clean read the
 * set of URLs the board lists IS the set of live postings — anything we hold
 * as active for that board and didn't see is gone.
 *
 * The danger is a bad read looking like an empty or shrunken board. So only a
 * board that fetched ok, is known complete and listed at least one posting is
 * trusted, and a pass that would close most of a larger company's jobs at once
 * is skipped as suspect (age-based expiry still backstops it).
 */

/** Skip a board when more than this share of its active jobs would close in one pass... */
export const SNAPSHOT_MAX_CLOSE_FRACTION = 0.5;
/** ...but only once it has at least this many active jobs; small boards churn legitimately. */
export const SNAPSHOT_GUARD_MIN_ACTIVE = 10;

export interface BoardSnapshot {
  source: string;      // job_postings.source the scrape writes, e.g. 'ATS:greenhouse'
  company: string;     // job_postings.company the scrape writes
  ok: boolean;         // the board was read successfully
  complete: boolean;   // the read returned every posting (not a truncated page)
  seenUrls: string[];
}

export interface SnapshotGroup {
  source: string;
  company: string;
  /** False when ANY board writing to this (source, company) failed or was partial. */
  usable: boolean;
  reason?: 'failed' | 'incomplete';
  seen: Set<string>;
}

export const groupKey = (source: string, company: string): string => `${source}\u0000${company}`;

/**
 * Two discovered_companies rows can write the same (source, company) — e.g. a
 * duplicate company entry with a second board id. Their jobs are
 * indistinguishable in job_postings, so the group is trusted only if every
 * board in it was read cleanly, and the seen set is their union.
 */
export function groupSnapshots(boards: BoardSnapshot[]): Map<string, SnapshotGroup> {
  const groups = new Map<string, SnapshotGroup>();
  for (const b of boards) {
    const key = groupKey(b.source, b.company);
    let g = groups.get(key);
    if (!g) {
      g = { source: b.source, company: b.company, usable: true, seen: new Set() };
      groups.set(key, g);
    }
    if (!b.ok) {
      g.usable = false;
      g.reason = 'failed';
    } else if (!b.complete) {
      g.usable = false;
      g.reason ??= 'incomplete';
    }
    for (const u of b.seenUrls) g.seen.add(u);
  }
  return groups;
}

export interface ActiveJobRow {
  id: number;
  externalUrl: string | null;
}

export type SnapshotDecision =
  | { action: 'close'; closeIds: number[] }
  | { action: 'skip'; reason: 'empty-board' | 'mass-drop'; wouldClose: number };

export function planBoardExpiry(active: ActiveJobRow[], seen: Set<string>): SnapshotDecision {
  // A row without a URL can't be matched against the board, so it's never closed here.
  const missing = active.filter(r => r.externalUrl && !seen.has(r.externalUrl));
  if (missing.length === 0) return { action: 'close', closeIds: [] };

  // A 200 with zero postings is how several ATSes answer for a board that was
  // renamed or moved — indistinguishable from "not hiring". Leave it to age expiry.
  if (seen.size === 0) return { action: 'skip', reason: 'empty-board', wouldClose: missing.length };

  if (active.length >= SNAPSHOT_GUARD_MIN_ACTIVE
      && missing.length / active.length > SNAPSHOT_MAX_CLOSE_FRACTION) {
    return { action: 'skip', reason: 'mass-drop', wouldClose: missing.length };
  }

  return { action: 'close', closeIds: missing.map(r => r.id) };
}
