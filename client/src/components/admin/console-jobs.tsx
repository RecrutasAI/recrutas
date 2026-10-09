import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Building2, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { adminFetch } from '@/lib/admin-fetch';
import { DailyColumns, HBars, StatTile, TableView, VIZ_TOKENS, type DayPoint } from './charts';
import { useAdminData } from './use-admin-data';

interface JobsInsights {
  live: number | null; companies: number | null;
  opened: DayPoint[]; closed: DayPoint[];
  bySource: Array<{ label: string; value: number }>;
}

const sum = (s: DayPoint[], from: number, to?: number) => s.slice(from, to).reduce((a, p) => a + p.value, 0);

/** A maintenance job that runs on request from the site (not the server's schedule). */
function MaintenanceCard({ title, icon, statsUrl, runUrl, runLabel, describe }: {
  title: string; icon: React.ReactNode; statsUrl: string; runUrl: string; runLabel: string;
  describe: (s: any) => Array<[string, string | number]>;
}) {
  const { toast } = useToast();
  const [stats, setStats] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const load = useCallback(async () => {
    const r = await adminFetch(statsUrl).catch(() => null);
    if (r?.ok) {setStats(await r.json());}
  }, [statsUrl]);
  useEffect(() => { load(); }, [load]);
  async function run() {
    setRunning(true);
    try {
      const r = await adminFetch(runUrl, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {throw new Error(body.message || `Failed (${r.status})`);}
      toast({ title: `${title}: done`, description: body.message });
      load();
    } catch (e: any) {
      toast({ title: `${title} failed`, description: e.message, variant: 'destructive' });
    } finally {
      setRunning(false);
    }
  }
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base flex items-center gap-2">{icon}{title}</CardTitle>
        <Button size="sm" variant="outline" onClick={run} disabled={running}>
          {running && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}{runLabel}
        </Button>
      </CardHeader>
      <CardContent>
        {!stats ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {describe(stats).map(([k, v]) => (
              <div key={k}><dt className="text-xs text-gray-500">{k}</dt><dd className="text-lg font-semibold text-gray-900 dark:text-white">{typeof v === 'number' ? v.toLocaleString('en-US') : v}</dd></div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Never');

export function ConsoleJobs() {
  const { data, error } = useAdminData<JobsInsights>('/api/admin/console/jobs');
  if (!data) {
    return <div className="flex items-center gap-2 text-sm text-gray-500 py-10 justify-center">
      {error ? <span className="text-red-600">{error}</span> : <><Loader2 className="h-4 w-4 animate-spin" /> Loading jobs…</>}
    </div>;
  }
  const opened = { thisWeek: sum(data.opened, -7), priorWeek: sum(data.opened, -14, -7) };
  const closedWeek = sum(data.closed, -7);
  const sourceTotal = data.bySource.reduce((a, s) => a + s.value, 0) || 1;

  return (
    <div className={`space-y-6 ${VIZ_TOKENS}`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Live jobs" value={data.live} sub="direct from company job boards" />
        <StatTile label="Companies hiring" value={data.companies} sub="with at least one live job" />
        <StatTile label="New jobs this week" value={opened.thisWeek} {...opened} trend={data.opened.map(p => p.value)} />
        <StatTile label="Jobs closed this week" value={closedWeek} sub={`${sum(data.closed, -14, -7).toLocaleString('en-US')} the week before · filled or taken down`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New vs closed jobs per day</CardTitle>
          <p className="text-xs text-gray-500">Last 28 days. New jobs above the line, closed jobs below it.</p>
        </CardHeader>
        <CardContent>
          <DailyColumns height={220} series={[
            { label: 'New', color: 'var(--viz-1)', points: data.opened },
            { label: 'Closed', color: 'var(--viz-2)', points: data.closed },
          ]} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Live jobs by hiring system</CardTitle>
          <p className="text-xs text-gray-500">Where each live job was read from.</p>
        </CardHeader>
        <CardContent>
          <HBars rows={data.bySource.map(s => ({ ...s, note: `${Math.round((s.value / sourceTotal) * 100)}%` }))} />
          <TableView head={['Hiring system', 'Live jobs']} rows={data.bySource.map(s => [s.label, s.value.toLocaleString('en-US')])} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <MaintenanceCard title="Ghost job detection" icon={<AlertTriangle className="h-4 w-4 text-gray-500" />}
          statsUrl="/api/admin/ghost-job-stats" runUrl="/api/admin/run-ghost-job-detection" runLabel="Run detection"
          describe={s => [['Checked', s.totalChecked ?? '—'], ['Ghosts found', s.ghostsFound ?? '—'], ['Hidden', s.deactivated ?? '—'], ['Last run', when(s.lastRun)]]} />
        <MaintenanceCard title="Company verification" icon={<Building2 className="h-4 w-4 text-gray-500" />}
          statsUrl="/api/admin/company-verification-stats" runUrl="/api/admin/run-company-verification" runLabel="Run verification"
          describe={s => [['Companies', s.totalCompanies ?? '—'], ['Verified', s.verified ?? '—'], ['Unverified', s.unverified ?? '—'], ['Last run', when(s.lastRun)]]} />
      </div>
    </div>
  );
}
