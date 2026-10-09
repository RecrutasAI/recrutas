import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { HBars, StatTile, TableView, VIZ_TOKENS } from './charts';
import { JobRow, SignalRow, useConsoleActions, useOverview } from './console-today';
import { useAdminData } from './use-admin-data';

interface AiInsights {
  resumes: number; readByAi: number; onRules: number; untracked: number;
  engines: Array<{ label: string; value: number; kind: Kind }>;
  recent: Array<{ at: string | null; email: string | null; engine: string; kind: Kind; skills: number | null; roles: number; status: string | null }>;
  matching: { liveJobs: number | null; matched: number | null };
}

type Kind = 'ai' | 'rules' | 'other';
/** AI = blue, rule engine = orange, unknown/failed = neutral gray (not a series color). */
const KIND_COLOR: Record<Kind, string> = { ai: 'var(--viz-1)', rules: 'var(--viz-2)', other: '#9ca3af' };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

export function ConsoleAi() {
  const { data, error, load } = useAdminData<AiInsights>('/api/admin/console/ai');
  const overview = useOverview();
  const actions = useConsoleActions(() => { overview.load(); load(); });

  if (!data) {
    return <div className="flex items-center gap-2 text-sm text-gray-500 py-10 justify-center">
      {error ? <span className="text-red-600">{error}</span> : <><Loader2 className="h-4 w-4 animate-spin" /> Loading AI & matching…</>}
    </div>;
  }
  const pctAi = data.resumes ? Math.round((data.readByAi / data.resumes) * 100) : null;
  const m = data.matching;
  const pctMatched = m.liveJobs ? Math.round(((m.matched ?? 0) / m.liveJobs) * 1000) / 10 : null;
  const o = overview.data;
  const signals = o ? o.signals.filter(s => s.key === 'aiParse' || s.key === 'embeddingBacklog') : [];
  const jobs = o ? o.jobs.filter(j => ['retry-failed-parses', 'check-ai-models', 'batch-embeddings'].includes(j.key)) : [];

  return (
    <div className={`space-y-6 ${VIZ_TOKENS}`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Resumes on file" value={data.resumes} />
        <StatTile label="Read by AI" value={data.readByAi} sub={pctAi === null ? undefined : `${pctAi}% of resumes${data.untracked ? ` · ${data.untracked} parsed before we recorded the engine` : ''}`} />
        <StatTile label="On the rule engine" value={data.onRules} sub="guesses until an AI reads them; retried every 10 min" />
        <StatTile label="Live jobs ready to match" value={m.matched} sub={pctMatched === null ? undefined : `${pctMatched}% of ${m.liveJobs?.toLocaleString('en-US')} live jobs`} />
      </div>

      {o && (
        <Card>
          <CardHeader><CardTitle className="text-base">Health</CardTitle></CardHeader>
          <CardContent>{signals.map(s => <SignalRow key={s.key} s={s} data={o} actions={actions} />)}</CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Who read each resume</CardTitle>
            <p className="text-xs text-gray-500">The latest parse of every resume on file. Free AI providers first; the rule engine only when all of them were out.</p>
          </CardHeader>
          <CardContent>
            <HBars rows={data.engines.map(e => ({ label: e.label, value: e.value, color: KIND_COLOR[e.kind] }))} />
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-600 dark:text-gray-300">
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: 'var(--viz-1)' }} aria-hidden />An AI read it</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: 'var(--viz-2)' }} aria-hidden />Rule engine (no AI)</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: KIND_COLOR.other }} aria-hidden />Unknown or failed</span>
            </div>
            <TableView head={['Read by', 'Resumes']} rows={data.engines.map(e => [e.label, e.value])} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">AI jobs</CardTitle></CardHeader>
          <CardContent>{jobs.length ? jobs.map(j => <JobRow key={j.key} job={j} actions={actions} />) : <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Latest resume parses</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th className="py-2 pr-3 font-medium">When</th><th className="py-2 pr-3 font-medium">Account</th><th className="py-2 pr-3 font-medium">Read by</th>
                <th className="py-2 pr-3 font-medium text-right">Skills</th><th className="py-2 font-medium text-right">Roles</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.recent.map((r, i) => (
                <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-3 whitespace-nowrap text-gray-600 dark:text-gray-300">{when(r.at)}</td>
                  <td className="py-2 pr-3 text-gray-800 dark:text-gray-200 max-w-[14rem] truncate" title={r.email ?? ''}>{r.email ?? '—'}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5 text-gray-800 dark:text-gray-200">
                      <span className="h-2 w-2 rounded-sm shrink-0" style={{ background: KIND_COLOR[r.kind] }} aria-hidden />{r.engine}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right text-gray-800 dark:text-gray-200">{r.skills ?? '—'}</td>
                  <td className="py-2 text-right text-gray-800 dark:text-gray-200">{r.roles}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {actions.dialog}
    </div>
  );
}
