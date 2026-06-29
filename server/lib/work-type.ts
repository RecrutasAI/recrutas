// Canonical work-type classifier.
//
// Historically `workType` was set by ~20 ad-hoc ingestion heuristics that scanned
// the whole job description "remote-first" and defaulted to `hybrid`. Because a
// stray "remote"/"flexible" anywhere in a long description won, clearly-located
// onsite roles were mislabelled remote/hybrid and `hybrid` became a junk bucket.
//
// The fix: treat the LOCATION field as the canonical signal — it is where an
// employer actually encodes the arrangement ("Remote", "Hybrid", or a city).
// The description is only a last-resort signal, and only when it says something
// unambiguous ("fully remote", "remote-first", …) — never a lone "remote".
// When nothing is decisive we default to `onsite`, the most common arrangement,
// rather than over-calling remote/hybrid.

export type CanonicalWorkType = 'remote' | 'hybrid' | 'onsite';

// Letter-bounded so "remotely" / "hybridize" prose can't trip it, but — unlike
// \b, which counts "_" as a word char — separators like "_", "-", "/" and digits
// DO count as boundaries, so location codes like "Remote_PA" still match.
const HYBRID_RE = /(?<![a-z])hybrid(?![a-z])/i;

// Explicit remote signals usable on ANY field (location or title).
const REMOTE_RE =
  /(?<![a-z])remote(?![a-z])|(?<![a-z])wfh(?![a-z])|work from home|work from anywhere|(?<![a-z])anywhere(?![a-z])|telecommute|fully[\s-]?distributed|distributed team/i;

// Strong remote phrases required before a DESCRIPTION (noisy, long) can decide.
// A bare "remote" in a description is deliberately NOT enough.
const STRONG_REMOTE_DESC_RE =
  /\bfully[\s-]?remote\b|\b100%\s*remote\b|\bremote[\s-]?first\b|\bwork from home\b|\bwork from anywhere\b|\btelecommute\b/i;

// Location strings that carry no real place (so they can't imply onsite).
const PLACELESS_RE =
  /^(n\/?a|none|null|various|multiple|multiple locations|tbd|unknown|global|worldwide|anywhere|flexible)$/i;

function norm(s: string | null | undefined): string {
  return (s ?? '').toString().trim();
}

// Does the location name an actual place (a city/state/country), as opposed to
// being empty or only an arrangement word like "Remote" / "various"?
function hasConcretePlace(loc: string): boolean {
  const stripped = loc
    .replace(REMOTE_RE, ' ')
    .replace(HYBRID_RE, ' ')
    .replace(/[^a-z]+/gi, ' ')
    .trim();
  if (!stripped) return false;
  if (PLACELESS_RE.test(stripped)) return false;
  return /[a-z]/i.test(stripped);
}

export interface ClassifyWorkTypeInput {
  location?: string | null;
  title?: string | null;
  description?: string | null;
}

/**
 * Classify a job's work arrangement from its posting fields.
 * Location-dominant; description only breaks ties with explicit phrasing.
 */
export function classifyWorkType(input: ClassifyWorkTypeInput): CanonicalWorkType {
  const location = norm(input.location);
  const title = norm(input.title);

  // 1) Location — the canonical, employer-encoded signal.
  if (location) {
    if (HYBRID_RE.test(location)) return 'hybrid';
    if (REMOTE_RE.test(location)) return 'remote';
    if (hasConcretePlace(location)) return 'onsite';
    // else: placeless location ("various", "global") — fall through.
  }

  // 2) Title — e.g. "Senior Engineer (Remote)".
  if (title) {
    if (HYBRID_RE.test(title)) return 'hybrid';
    if (REMOTE_RE.test(title)) return 'remote';
  }

  // 3) Description — only unambiguous phrasing, never a lone "remote".
  const description = norm(input.description);
  if (description) {
    if (STRONG_REMOTE_DESC_RE.test(description)) return 'remote';
    if (HYBRID_RE.test(description)) return 'hybrid';
  }

  // 4) Default — most roles are onsite; don't over-call remote/hybrid.
  return 'onsite';
}
