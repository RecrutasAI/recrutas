import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { DailyColumns, Funnel, StatTile, VIZ_TOKENS, type DayPoint } from './charts';
import { useAdminData } from './use-admin-data';

interface Growth {
  generatedAt: string;
  series: { signups: DayPoint[]; resumes: DayPoint[]; applications: DayPoint[] };
  funnel: Array<{ label: string; value: number | null; source: 'database' | 'site analytics' }>;
}
/** Site analytics (PostHog) is slow, so it loads after the database numbers. */
interface Analytics { available: boolean; visitors: DayPoint[]; funnel: Record<string, number | null> }

const sum = (s: DayPoint[], from: number, to?: number) => s.slice(from, to).reduce((a, p) => a + p.value, 0);
const week = (s: DayPoint[]) => ({ thisWeek: sum(s, -7), priorWeek: sum(s, -14, -7) });

interface Pitch {
  kpis?: { total_employers: number; internal_jobs: number; total_chats: number } | null;
  funnel?: { took_exam: number; passed_exam: number } | null;
  sla?: { total_passed: number; compliance_pct: number | string | null } | null;
}

function Phase2() {
  const { data, error } = useAdminData<Pitch>('/api/admin/metrics/pitch', 30 * 60_000);
  if (!data) {return error ? <p className="text-sm text-red-600">{error}</p> : <Loader2 className="h-5 w-5 animate-spin text-gray-400" />;}
  const pct = data.sla?.compliance_pct;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      <StatTile label="Employers signed up" value={data.kpis?.total_employers ?? null} />
      <StatTile label="Jobs posted on Recrutas" value={data.kpis?.internal_jobs ?? null} />
      <StatTile label="Exams taken" value={data.funnel?.took_exam ?? null} sub={data.funnel ? `${data.funnel.passed_exam} passed` : undefined} />
      <StatTile label="Chats opened" value={data.kpis?.total_chats ?? null} />
      <StatTile label="Replies within 24 h" value={data.sla?.total_passed ? Number(pct ?? 0) : null} sub={data.sla?.total_passed ? '% of passed candidates' : 'no exams passed yet'} />
    </div>
  );
}

export function ConsoleGrowth() {
  const { data, error } = useAdminData<Growth>('/api/admin/console/growth');
  const analytics = useAdminData<Analytics>('/api/admin/console/growth/analytics', 10 * 60_000);
  const [phase2, setPhase2] = useState(false);

  if (!data) {
    return <div className="flex items-center gap-2 text-sm text-gray-500 py-10 justify-center">
      {error ? <span className="text-red-600">{error}</span> : <><Loader2 className="h-4 w-4 animate-spin" /> Loading growth…</>}
    </div>;
  }
  const s = data.series;
  const a = analytics.data;
  const funnel = data.funnel.map(step => (step.source === 'site analytics' && a ? { ...step, value: a.funnel[step.label] ?? null } : step));
  const tiles = [
    { label: 'Visitors this week', series: a?.visitors ?? [],
      sub: !a ? (analytics.error ? 'site analytics unavailable' : 'loading site analytics…') : a.available ? 'site analytics' : 'site analytics not connected' },
    { label: 'Sign-ups this week', series: s.signups },
    { label: 'Resumes processed this week', series: s.resumes },
    { label: 'Applications this week', series: s.applications },
  ];

  return (
    <div className={`space-y-6 ${VIZ_TOKENS}`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {tiles.map(t => (
          <StatTile key={t.label} label={t.label} value={t.series.length ? week(t.series).thisWeek : null}
            {...(t.series.length ? week(t.series) : {})} trend={t.series.map(p => p.value)} sub={t.sub} />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Candidate funnel, last 30 days</CardTitle>
          <p className="text-xs text-gray-500">
            People who did each step in the last 30 days. Darker bars come from the database (exact). Lighter bars come from site analytics,
            which misses people with ad blockers, so they read low; these steps are counted on their own, not followed person by person.
          </p>
        </CardHeader>
        <CardContent>
          <Funnel steps={funnel} pendingSource={!a && !analytics.error ? 'site analytics' : undefined} />
          {!a && !analytics.error && <p className="mt-3 text-xs text-gray-500 flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />Loading site analytics (takes a few seconds)…</p>}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Sign-ups per day</CardTitle><p className="text-xs text-gray-500">Last 28 days</p></CardHeader>
          <CardContent><DailyColumns series={[{ label: 'Sign-ups', color: 'var(--viz-1)', points: s.signups }]} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Applications per day</CardTitle><p className="text-xs text-gray-500">Last 28 days</p></CardHeader>
          <CardContent><DailyColumns series={[{ label: 'Applications', color: 'var(--viz-1)', points: s.applications }]} /></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <button className="text-left" onClick={() => setPhase2(v => !v)} aria-expanded={phase2}>
            <CardTitle className="text-base">{phase2 ? '▾' : '▸'} Phase 2: employers, exams and chat</CardTitle>
            <p className="text-xs text-gray-500 mt-1">Not live yet. These stay near zero until employers post jobs on Recrutas.</p>
          </button>
        </CardHeader>
        {phase2 && (
          <CardContent>
            <Phase2 />
          </CardContent>
        )}
      </Card>
    </div>
  );
}
