/**
 * Server-side email+password check against Supabase Auth.
 *
 * Supabase enforces CAPTCHA on password sign-in once it's enabled for the
 * project, and a server has no browser to solve one. Supabase Auth skips the
 * CAPTCHA check when the request carries admin credentials
 * (supabase/auth internal/api/middleware.go, verifyCaptcha →
 * requireAdminCredentials), so this sends the service-role key as the bearer.
 * The password is still verified normally.
 *
 * Only for server routes that already rate-limit their callers: the
 * extension login and the settings "current password" check. Browser sign-in
 * must keep going straight to Supabase with a CAPTCHA token.
 */
export type PasswordGrantResult =
  | { ok: true; session: any }
  | { ok: false; status: number; message: string };

export async function passwordGrant(email: string, password: string): Promise<PasswordGrantResult> {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return { ok: false, status: 503, message: 'Auth service not configured' };
  }

  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({})) as any;
  if (!res.ok) {
    return { ok: false, status: 401, message: body?.error_description || body?.msg || body?.message || 'Invalid credentials' };
  }
  return { ok: true, session: body };
}
