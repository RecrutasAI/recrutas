import { sql } from 'drizzle-orm/sql';

/**
 * Accounts that are not real people: automated test sign-ups on example.com/.org/.net and
 * plus-aliases such as you+e2e1008@gmail.com. On 2026-10-10 they were 42 of 62 accounts and
 * all 9 "failed" resumes, so admin numbers count real people only.
 */
export const TEST_EMAIL_PATTERN = '(@example\\.(com|org|net)$|\\+(e2e|test)[^@]*@)';

export const isTestEmail = (email: string | null | undefined): boolean =>
  !!email && new RegExp(TEST_EMAIL_PATTERN, 'i').test(email);

/** Subquery of real users' ids, for `... AND user_id IN ${realUserIds}`. */
export const realUserIds = sql`(SELECT id FROM users WHERE email IS NULL OR email !~* ${TEST_EMAIL_PATTERN})`;
