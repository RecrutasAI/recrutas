import { useSiteStatus } from '@/hooks/use-site-status';

/** The admin console's site notice, shown at the top of every page while it's set. */
export function SiteNoticeBanner() {
  const { notice } = useSiteStatus();
  if (!notice) {return null;}
  const warning = notice.level === 'warning';
  return (
    <div
      role="status"
      className={`w-full px-4 py-2 text-center text-sm ${warning
        ? 'bg-amber-50 text-amber-900 border-b border-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-900'
        : 'bg-emerald-50 text-emerald-900 border-b border-emerald-200 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-900'}`}
    >
      {notice.text}
    </div>
  );
}
