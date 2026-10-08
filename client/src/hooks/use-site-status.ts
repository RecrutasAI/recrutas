import { useQuery } from '@tanstack/react-query';

export interface SiteStatus {
  notice: { text: string; level: 'info' | 'warning' } | null;
  signupWaitlist: boolean;
}

const OPEN: SiteStatus = { notice: null, signupWaitlist: false };

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
      if (!r.ok) {return OPEN;}
      return r.json();
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  });
  return data ?? OPEN;
}
