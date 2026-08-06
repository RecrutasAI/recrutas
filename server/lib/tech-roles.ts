/**
 * Shared tech-role title signal.
 *
 * Used to bias company discovery toward companies that actually hire knowledge
 * workers, rather than whoever posts the most roles (see below).
 *
 * WHY THIS EXISTS: `discover-companies` mines company names out of
 * `job_postings` — i.e. companies we already ingest — and the Wikipedia seed is
 * disabled. That makes discovery a closed loop: whatever the feed already skews
 * toward, it discovers more of. Measured 2026-08-06, the live feed was ~20% tech
 * because ATS discovery naturally finds high-turnover employers (drivers, ABA
 * therapy, delivery, restaurants, commission sales) — they simply post more
 * roles than stable engineering orgs do.
 *
 * This pattern is a RANKING signal, never a filter. A false positive only
 * reorders the probe queue slightly; nothing is ever excluded because of it, so
 * the blast radius of a bad match is near zero.
 *
 * Deliberately does NOT match a bare "engineer" — that would sweep in civil,
 * mechanical, structural, field and sales engineers, which is exactly the
 * generalist supply we're trying to rank *below* tech.
 */
export const TECH_TITLE_PATTERN =
  '(software|firmware|backend|back.end|frontend|front.end|full.?stack|web develop|developer|programmer|\\mswe\\M' +
  '|data scien|machine learning|deep learning|\\mnlp\\M|computer vision|research scientist' +
  '|data engineer|analytics engineer|data analyst|business intelligence' +
  '|devops|\\msre\\M|site reliability|platform engineer|infrastructure engineer|cloud (engineer|architect)' +
  '|systems engineer|network engineer' +
  '|security engineer|infosec|cyber ?security|appsec|penetration test' +
  '|product manager|product owner|technical program manager' +
  '|product designer|\\mux\\M|\\mui\\M|user experience' +
  '|\\mqa\\M|quality assurance|test engineer|automation engineer' +
  '|solutions architect|software architect|engineering manager|technical lead)';
