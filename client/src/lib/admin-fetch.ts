import { supabase } from '@/lib/supabase-client';

/**
 * Headers for /api/admin/* calls. Admins sign in with their normal Recrutas
 * account (ADMIN_EMAILS on the server); the admin secret is a fallback for
 * scripts and is only sent when one was entered in this browser tab.
 */
export async function adminHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...extra };
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {headers.Authorization = `Bearer ${session.access_token}`;}
  } catch { /* signed out */ }
  try {
    const secret = sessionStorage.getItem('admin_secret');
    if (secret) {headers['x-admin-secret'] = secret;}
  } catch { /* storage blocked */ }
  return headers;
}

export async function adminFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const base = (init.headers ?? {}) as Record<string, string>;
  return fetch(url, { ...init, headers: await adminHeaders(base) });
}
