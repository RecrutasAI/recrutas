/**
 * A sign-up ?code= as stored on the account (users.invite_code_used): upper case, letters, digits
 * and dashes, 40 at most (the column). Campaign codes with no invite row (HN-47T1WO, RR-KING) are
 * kept whole so sign-ups can be counted per launch post or partner, not only per channel prefix.
 */
export function campaignCode(raw: string): string | undefined {
  const c = raw.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40);
  return c || undefined;
}
