import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { DailyColumns, HBars, TableView, type DayPoint } from './charts';
import { useAdminData } from './use-admin-data';

interface LatencyRow { endpoint: string; method: string; count: number; p50: number; p95: number; errors: number }
interface ErrorRow { hour: string; total: number; errors: number }
interface PipelineHealth {
  pipeline: string; status: 'ok' | 'warning' | 'failed' | 'stale' | 'never';
  ageMinutes: number | null; message: string | null;
}

/** Requests slower than this at p95 feel broken to a person waiting on them. */
const BUDGET_MS = 1000;
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric' });

/** The last 24 hours, one point per hour, oldest first; hours with no traffic are 0. */
function fillHours(rows: ErrorRow[]): DayPoint[] {
  const by = new Map(rows.map(r => [new Date(r.hour).toISOString().slice(0, 13), Number(r.errors) || 0]));
  const now = new Date(); now.setUTCMinutes(0, 0, 0);
  return Array.from({ length: 24 }, (_, i) => {
    const t = new Date(now.getTime() - (23 - i) * 3_600_000).toISOString();
    return { date: t, value: by.get(t.slice(0, 13)) ?? 0 };
  });
}

export function SpeedCard() {
  const { data } = useAdminData<{ data: LatencyRow[] }>('/api/admin/metrics/latency?hours=24');
  const rows = (data?.data ?? []).filter(r => r.count >= 5).sort((a, b) => b.p95 - a.p95).slice(0, 5);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Slowest pages and API calls</CardTitle>
        <p className="text-xs text-gray-500">Last 24 hours, 95th-percentile response time, endpoints with at least 5 requests.</p>
      </CardHeader>
      <CardContent>
        {!data ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : rows.length === 0 ? <p className="text-sm text-gray-500">Not enough traffic in the last 24 hours to measure.</p> : (
          <>
            <HBars rows={rows.map(r => ({ label: `${r.method} ${r.endpoint}`, value: r.p95, note: `${r.count.toLocaleString('en-US')} req`, color: r.p95 > BUDGET_MS ? 'var(--viz-2)' : 'var(--viz-1)' }))}
              format={ms} budget={BUDGET_MS} budgetLabel="the 1-second target; orange bars are over it" />
            <TableView head={['Endpoint', 'Requests', 'Median', 'p95', 'Server errors']}
              rows={rows.map(r => [`${r.method} ${r.endpoint}`, r.count, ms(r.p50), ms(r.p95), r.errors])} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function ErrorsCard() {
  const { data } = useAdminData<{ data: ErrorRow[] }>('/api/admin/metrics/errors?hours=24');
  const points = fillHours(data?.data ?? []);
  const total = points.reduce((a, p) => a + p.value, 0);
  const requests = (data?.data ?? []).reduce((a, r) => a + (Number(r.total) || 0), 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Server errors per hour</CardTitle>
        <p className="text-xs text-gray-500">
          Last 24 hours: {total.toLocaleString('en-US')} server error{total === 1 ? '' : 's'} out of {requests.toLocaleString('en-US')} requests.
          Details are on the Errors tab.
        </p>
      </CardHeader>
      <CardContent>
        {!data ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : (
          <DailyColumns series={[{ label: 'Server errors', color: 'var(--viz-2)', points }]} height={150}
            labelOf={hourLabel} period="last 24 hours" firstColumn="Hour" />
        )}
      </CardContent>
    </Card>
  );
}

const PIPE_STYLE: Record<PipelineHealth['status'], { dot: string; word: string }> = {
  ok: { dot: 'bg-emerald-500', word: 'ok' },
  warning: { dot: 'bg-amber-500', word: 'throttled' },
  failed: { dot: 'bg-red-500', word: 'failed' },
  stale: { dot: 'bg-red-500', word: 'late' },
  never: { dot: 'bg-gray-400', word: 'no runs yet' },
};
const age = (m: number | null) => (m === null ? '—' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`);

export function PipelinesCard() {
  const { data } = useAdminData<PipelineHealth[]>('/api/admin/pipeline-health');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Every scheduled job</CardTitle>
        <p className="text-xs text-gray-500">Including backups and the ones that can't be run from here. Late means it hasn't reported within its usual interval.</p>
      </CardHeader>
      <CardContent>
        {!data ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {data.map(p => {
              const st = PIPE_STYLE[p.status] ?? PIPE_STYLE.never;
              return (
                <li key={p.pipeline} className="py-2 grid grid-cols-[minmax(0,12rem)_6rem_minmax(0,1fr)] gap-3 items-center text-sm">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${st.dot}`} aria-hidden />
                    <span className="font-mono text-xs text-gray-800 dark:text-gray-200 truncate">{p.pipeline}</span>
                  </span>
                  <span className="text-xs text-gray-500">{age(p.ageMinutes)}</span>
                  <span className="text-xs text-gray-600 dark:text-gray-400 truncate" title={p.message ?? ''}>{st.word}{p.message ? ` · ${p.message}` : ''}</span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
