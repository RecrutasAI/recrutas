import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw } from 'lucide-react';
import { adminFetch } from '@/lib/admin-fetch';

export type Level = 'green' | 'amber' | 'red' | 'unknown';

export interface Signal {
  key: string; label: string; value: number | null; display: string; level: Level;
  healthy: string; actAt: string; playbook: string;
}

export interface Overview {
  generatedAt: string;
  level: Level;
  today: {
    signups24h: number | null; signups7d: number | null; users: number | null; activeUsers7d: number | null;
    resumes: number | null; applications7d: number | null; liveJobs: number | null; jobsOpened24h: number | null; jobsClosed24h: number | null;
  };
  signals: Signal[];
}

export const LEVEL_STYLE: Record<Level, { dot: string; chip: string; word: string }> = {
  green: { dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300', word: 'Healthy' },
  amber: { dot: 'bg-amber-500', chip: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300', word: 'Watch' },
  red: { dot: 'bg-red-500', chip: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300', word: 'Act now' },
  unknown: { dot: 'bg-gray-400', chip: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400', word: 'Not measured' },
};

const fmt = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US'));

/** Loads the console overview and refreshes it every minute. */
export function useOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminFetch('/api/admin/console/overview');
      if (!r.ok) {throw new Error(r.status === 401 ? 'Your admin session ended. Sign in again.' : `The overview failed to load (${r.status}).`);}
      setData(await r.json()); setError(null);
    } catch (e: any) {
      setError(e.message || 'The overview failed to load.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  return { data, loading, error, load };
}

export function SignalRow({ s }: { s: Signal }) {
  const st = LEVEL_STYLE[s.level];
  return (
    <div className="flex flex-col gap-1 py-3 border-b last:border-b-0 border-gray-100 dark:border-gray-800 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex items-center gap-2 sm:w-64 shrink-0">
        <span className={`h-2.5 w-2.5 rounded-full ${st.dot}`} aria-hidden />
        <span className="text-sm font-medium text-gray-900 dark:text-white">{s.label}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-white">{s.display}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full ${st.chip}`}>{st.word}</span>
          <span className="text-xs text-gray-500">Healthy {s.healthy} · act {s.actAt}</span>
        </div>
        {(s.level === 'red' || s.level === 'amber') && (
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{s.playbook}</p>
        )}
      </div>
    </div>
  );
}

export function ConsoleToday() {
  const { data, loading, error, load } = useOverview();

  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-10 justify-center">
        {error ? <span className="text-red-600">{error}</span> : <><Loader2 className="h-4 w-4 animate-spin" /> Loading today's numbers…</>}
      </div>
    );
  }

  const st = LEVEL_STYLE[data.level];
  const needsAction = data.signals.filter(s => s.level === 'red' || s.level === 'amber');
  const t = data.today;
  const tiles: [string, number | null, string?][] = [
    ['Sign-ups today', t.signups24h, `${fmt(t.signups7d)} this week`],
    ['Active this week', t.activeUsers7d, `of ${fmt(t.users)} accounts`],
    ['Resumes on file', t.resumes],
    ['Applications this week', t.applications7d],
    ['Live jobs', t.liveJobs, `+${fmt(t.jobsOpened24h)} opened · ${fmt(t.jobsClosed24h)} closed today`],
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className={`h-4 w-4 rounded-full ${st.dot}`} aria-hidden />
            <div>
              <p className="text-lg font-semibold text-gray-900 dark:text-white">
                {data.level === 'green' ? 'Everything is healthy' : data.level === 'unknown' ? 'Not enough data yet' : `${needsAction.length} thing${needsAction.length === 1 ? '' : 's'} need${needsAction.length === 1 ? 's' : ''} attention`}
              </p>
              <p className="text-xs text-gray-500">Updated {new Date(data.generatedAt).toLocaleTimeString()} · refreshes every minute</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-2">Refresh</span>
          </Button>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {tiles.map(([label, value, sub]) => (
          <Card key={label}>
            <CardContent className="pt-5">
              <p className="text-xs text-gray-500">{label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-gray-900 dark:text-white">{fmt(value)}</p>
              {sub && <p className="mt-1 text-xs text-gray-500">{sub}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      {needsAction.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Needs attention</CardTitle></CardHeader>
          <CardContent>{needsAction.map(s => <SignalRow key={s.key} s={s} />)}</CardContent>
        </Card>
      )}
    </div>
  );
}
