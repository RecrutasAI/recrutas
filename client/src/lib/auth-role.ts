export type AppRole = 'candidate' | 'talent_owner' | 'recruiter';

const ROLES: readonly string[] = ['candidate', 'talent_owner', 'recruiter'];

// Loose on purpose: Supabase's User, the session user, and useAuth's merged
// user all fit, and none of their metadata types declare `role`.
interface RoleCarrier {
  user_metadata?: Record<string, unknown> | null;
  app_metadata?: Record<string, unknown> | null;
  role?: unknown;
}

/**
 * The signed-in user's role, wherever it was recorded.
 *
 * Email signups carry it in `user_metadata` (set by SignUpForm). Accounts that
 * arrive without one — every first "Continue with Google" — get it from
 * POST /api/auth/role, which writes `app_metadata` and the users row, never
 * `user_metadata`. Reading only `user_metadata` sent those accounts back into
 * onboarding on every visit; reading only the token missed the role until the
 * token refreshed, an hour later. `role` is the users-row value that useAuth
 * merges in from /api/auth/user.
 */
export function getUserRole(user: RoleCarrier | null | undefined): AppRole | null {
  if (!user) {return null;}
  for (const value of [user.user_metadata?.role, user.app_metadata?.role, user.role]) {
    if (typeof value === 'string' && ROLES.includes(value)) {return value as AppRole;}
  }
  return null;
}
