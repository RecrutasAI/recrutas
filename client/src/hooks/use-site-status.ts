import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AUTH_URL_KEY } from '@/lib/supabase-client';

export interface SiteStatus {
  notice: { text: string; level: 'info' | 'warning' } | null;
  signupWaitlist: boolean;
  /** Set only while sign-in runs on our backup server instead of Supabase. */
  authUrl?: string | null;
}

const OPEN: SiteStatus = { notice: null, signupWaitlist: false };

/**
 * Follow the console's sign-in server switch: when it changes, remember the new address
 * and reload once, so the sign-in client is created against it. A failed status read
 * never switches anything.
 */
function useFollowAuthServer(authUrl: string | null | undefined, loaded: boolean): void {
  useEffect(() => {
    if (!loaded) {return;}
    let current: string | null = null;
    try { current = window.localStorage.getItem(AUTH_URL_KEY); } catch { return; }
    const wanted = authUrl || null;
    if (wanted === current) {return;}
    try {
      if (wanted) {window.localStorage.setItem(AUTH_URL_KEY, wanted);}
      else {window.localStorage.removeItem(AUTH_URL_KEY);}
    } catch { return; }
    window.location.reload();
  }, [authUrl, loaded]);
}

/**
 * The admin console's public switches: the site notice banner and the sign-up
 * waitlist. If the status can't be read, the site behaves normally (no banner,
 * sign-ups open): a status outage must never lock people out.
 */
export function useSiteStatus(): SiteStatus {
  const { data } = useQuery<SiteStatus>({
    queryKey: ['site-status'],
    queryFn: async () => {
      const r = await fetch('/api/site/status');
      if (!r.ok) {return OPEN;}   // no authUrl key: never switches anything
      return r.json();
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  });
  // Only a real answer from the server can switch sign-in servers (never the OPEN default).
  useFollowAuthServer(data?.authUrl, !!data && 'authUrl' in data);
  return data ?? OPEN;
}
