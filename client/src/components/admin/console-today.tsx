import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BellOff, CircleDollarSign, Loader2, Play, RefreshCw, ToggleRight } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { adminFetch } from '@/lib/admin-fetch';

export type Level = 'green' | 'amber' | 'red' | 'unknown';

export type SignalAction =
  | { kind: 'run'; job: string; label: string }
  | { kind: 'setting'; key: string; value: unknown; label: string }
  | { kind: 'decision'; label: string; detail: string };

export interface Signal {
  key: string; label: string; value: number | null; display: string; level: Level;
  healthy: string; actAt: string; playbook: string;
  actions: SignalAction[];
  snoozedUntil?: string | null;
}

export interface JobRequest {
  id: number; job: string; requestedBy: string; reason: string; requestedAt: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt: string | null; finishedAt: string | null; result: string | null;
}

export interface ConsoleJob {
  key: string; title: string; description: string;
  lastRun: { status: string; at: string; message: string | null } | null;
  request: JobRequest | null;
}

export interface Overview {
  generatedAt: string;
  level: Level;
  today: {
    signups24h: number | null; signups7d: number | null; users: number | null; activeUsers7d: number | null;
    resumes: number | null; applications7d: number | null; liveJobs: number | null; jobsOpened24h: number | null; jobsClosed24h: number | null;
  };
  signals: Signal[];
  settings: Record<string, unknown>;
  jobs: ConsoleJob[];
  snoozes: Record<string, { until: string; by: string; reason: string }>;
}

export const LEVEL_STYLE: Record<Level, { dot: string; chip: string; word: string }> = {
  green: { dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300', word: 'Healthy' },
  amber: { dot: 'bg-amber-500', chip: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300', word: 'Watch' },
  red: { dot: 'bg-red-500', chip: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300', word: 'Act now' },
  unknown: { dot: 'bg-gray-400', chip: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400', word: 'Not measured' },
};

const fmt = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US'));
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const when = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? time(iso) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const isOpen = (r: JobRequest | null | undefined) => !!r && (r.status === 'queued' || r.status === 'running');

/** Loads the console overview: every minute, every 10 s while a requested job is queued or running. */
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
  const busy = !!data?.jobs?.some(j => isOpen(j.request));
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, busy ? 10_000 : 60_000); return () => clearInterval(t); }, [load, busy]);
  return { data, loading, error, load };
}

// ── Confirm-with-reason dialog (every action is audited) ─────────────────────

interface Pending { title: string; description: string; confirm: string; reason: string; submit: (reason: string) => Promise<void> }

function ReasonDialog({ pending, onClose }: { pending: Pending; onClose: () => void }) {
  const [reason, setReason] = useState(pending.reason);
  const [saving, setSaving] = useState(false);
  async function go() {
    setSaving(true);
    try { await pending.submit(reason.trim()); onClose(); } finally { setSaving(false); }
  }
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{pending.title}</DialogTitle>
          <DialogDescription>{pending.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="action-reason">Reason (goes in the audit log)</Label>
          <Textarea id="action-reason" rows={2} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={saving || !reason.trim()}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}{pending.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Actions open a confirm dialog; returns the triggers and the dialog to render. */
export function useConsoleActions(onChanged: () => void) {
  const { toast } = useToast();
  const [pending, setPending] = useState<Pending | null>(null);

  const call = useCallback(async (url: string, init: RequestInit, done: string) => {
    const r = await adminFetch(url, { ...init, headers: { 'Content-Type': 'application/json' } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast({ title: 'Not done', description: body.message || `Request failed (${r.status})`, variant: 'destructive' });
      throw new Error(body.message);
    }
    toast({ title: done });
    onChanged();
  }, [toast, onChanged]);

  const runJob = (job: string, title: string, description: string, context: string) => setPending({
    title, description: `${description} It starts on the server within a minute; progress shows here.`,
    confirm: 'Run now', reason: context,
    submit: reason => call(`/api/admin/jobs/${job}/run`, { method: 'POST', body: JSON.stringify({ reason }) }, `${title}: queued`),
  });
  const setSetting = (key: string, value: unknown, label: string, context: string) => setPending({
    title: label, description: 'Changes a live switch for the whole site. You can change it back under System & scaling.',
    confirm: 'Apply', reason: context,
    submit: reason => call(`/api/admin/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value, reason }) }, `${label}: done`),
  });
  const snooze = (s: Signal) => setPending({
    title: `Snooze "${s.label}" for 24 hours`,
    description: 'It stays on System & scaling, but leaves "Needs attention" and the overall status until then.',
    confirm: 'Snooze', reason: '',
    submit: reason => call(`/api/admin/signals/${s.key}/snooze`, { method: 'POST', body: JSON.stringify({ hours: 24, reason }) }, 'Snoozed for 24 hours'),
  });
  const unsnooze = (s: Signal) => call(`/api/admin/signals/${s.key}/snooze`, { method: 'DELETE' }, 'Snooze removed').catch(() => {});

  const dialog = pending ? <ReasonDialog pending={pending} onClose={() => setPending(null)} /> : null;
  return { runJob, setSetting, snooze, unsnooze, dialog };
}

// ── Job status line ──────────────────────────────────────────────────────────

export function RequestStatus({ request }: { request: JobRequest }) {
  const by = request.requestedBy === 'admin-secret' ? 'script' : request.requestedBy.split('@')[0];
  const text = {
    queued: `Queued ${time(request.requestedAt)} by ${by} · waiting for the server`,
    running: `Running since ${time(request.startedAt ?? request.requestedAt)}`,
    done: `Done ${request.finishedAt ? when(request.finishedAt) : ''}${request.result ? ` · ${request.result}` : ''}`,
    failed: `Failed ${request.finishedAt ? when(request.finishedAt) : ''}${request.result ? ` · ${request.result}` : ''}`,
    skipped: `Didn't run${request.result ? ` · ${request.result}` : ''}`,
  }[request.status];
  const tone = request.status === 'failed' ? 'text-red-600 dark:text-red-400'
    : request.status === 'done' ? 'text-emerald-700 dark:text-emerald-400' : 'text-gray-600 dark:text-gray-300';
  // A queued request the server hasn't picked up in 3 minutes means the server or its scheduler is down.
  const stale = request.status === 'queued' && Date.now() - Date.parse(request.requestedAt) > 3 * 60_000;
  return (
    <p className={`text-xs ${tone} flex items-center gap-1.5`}>
      {isOpen(request) && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
      <span className="min-w-0 break-words">{text}</span>
      {stale && <span className="text-red-600 dark:text-red-400"> · not picked up after 3 min: the server or its scheduler may be down</span>}
    </p>
  );
}

// ── Job row (a scheduled job with Run now) ──────────────────────────────────

const RUN_STATUS: Record<string, { dot: string; word: string }> = {
  ok: { dot: 'bg-emerald-500', word: 'ok' },
  warning: { dot: 'bg-amber-500', word: 'warning' },
  error: { dot: 'bg-red-500', word: 'failed' },
};

export function JobRow({ job: j, actions }: { job: ConsoleJob; actions: ReturnType<typeof useConsoleActions> }) {
  const last = j.lastRun ? RUN_STATUS[j.lastRun.status] ?? { dot: 'bg-gray-400', word: j.lastRun.status } : null;
  const busy = isOpen(j.request);
  return (
    <div className="flex flex-col gap-2 py-3 border-b last:border-b-0 border-gray-100 dark:border-gray-800 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-gray-900 dark:text-white">{j.title}</p>
        <p className="text-xs text-gray-500">{j.description}</p>
        {j.lastRun && last && (
          <p className="text-xs text-gray-600 dark:text-gray-300 flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full shrink-0 ${last.dot}`} aria-hidden />
            <span className="min-w-0 break-words">Last run {when(j.lastRun.at)} · {last.word}{j.lastRun.message ? ` · ${j.lastRun.message}` : ''}</span>
          </p>
        )}
        {j.request && <RequestStatus request={j.request} />}
      </div>
      <Button size="sm" variant="outline" className="shrink-0" disabled={busy}
        onClick={() => actions.runJob(j.key, j.title, j.description, `Run "${j.title}" from the console`)}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}Run now
      </Button>
    </div>
  );
}

// ── Signal row ───────────────────────────────────────────────────────────────

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function SignalRow({ s, data, actions }: { s: Signal; data: Overview; actions: ReturnType<typeof useConsoleActions> }) {
  const st = LEVEL_STYLE[s.level];
  const attention = s.level === 'red' || s.level === 'amber';
  const jobs = new Map(data.jobs.map(j => [j.key, j]));
  // A switch already in the wanted position has nothing to offer.
  const offered = (s.actions ?? []).filter(a => a.kind !== 'setting' || !same(data.settings?.[a.key], a.value));
  const context = `${s.label}: ${s.display}`;

  return (
    <div className="py-4 border-b last:border-b-0 border-gray-100 dark:border-gray-800">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-4">
        <div className="flex items-center gap-2 sm:w-64 shrink-0">
          <span className={`h-2.5 w-2.5 rounded-full ${st.dot}`} aria-hidden />
          <span className="text-sm font-medium text-gray-900 dark:text-white">{s.label}</span>
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-white">{s.display}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${st.chip}`}>{s.snoozedUntil ? 'Snoozed' : st.word}</span>
            <span className="text-xs text-gray-500">Healthy {s.healthy} · act {s.actAt}</span>
          </div>

          {attention && <p className="text-sm text-gray-600 dark:text-gray-300">{s.playbook}</p>}

          {attention && offered.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {offered.map(a => {
                  if (a.kind === 'run') {
                    const job = jobs.get(a.job);
                    const busy = isOpen(job?.request);
                    return (
                      <Button key={a.label} size="sm" disabled={busy} className="h-auto min-h-9 max-w-full whitespace-normal text-left py-1.5"
                        onClick={() => actions.runJob(a.job, job?.title ?? a.label, job?.description ?? '', `${a.label} (${context})`)}>
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}{a.label}
                      </Button>
                    );
                  }
                  if (a.kind === 'setting') {
                    return (
                      <Button key={a.label} size="sm" variant="outline" className="h-auto min-h-9 max-w-full whitespace-normal text-left py-1.5" onClick={() => actions.setSetting(a.key, a.value, a.label, `${a.label} (${context})`)}>
                        <ToggleRight className="h-3.5 w-3.5 mr-1.5" />{a.label}
                      </Button>
                    );
                  }
                  return null;
                })}
              </div>
              {offered.filter(a => a.kind === 'run').map(a => {
                const r = a.kind === 'run' ? jobs.get(a.job)?.request : null;
                return r ? <RequestStatus key={`st-${a.label}`} request={r} /> : null;
              })}
              {offered.filter((a): a is Extract<SignalAction, { kind: 'decision' }> => a.kind === 'decision').map(a => (
                <div key={a.label} className="flex gap-2 rounded-md border border-dashed border-gray-300 dark:border-gray-700 px-3 py-2 text-xs text-gray-600 dark:text-gray-300">
                  <CircleDollarSign className="h-4 w-4 shrink-0 text-gray-400" />
                  <span><b className="text-gray-800 dark:text-gray-100">Decision · {a.label}.</b> {a.detail}</span>
                </div>
              ))}
            </div>
          )}

          {attention && (
            s.snoozedUntil ? (
              <p className="text-xs text-gray-500">
                Snoozed until {when(s.snoozedUntil)}{data.snoozes?.[s.key]?.reason ? ` · "${data.snoozes[s.key].reason}"` : ''}{' · '}
                <button className="underline underline-offset-2 hover:no-underline" onClick={() => actions.unsnooze(s)}>unsnooze</button>
              </p>
            ) : (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-gray-500" onClick={() => actions.snooze(s)}>
                <BellOff className="h-3.5 w-3.5 mr-1.5" />Snooze 24 h
              </Button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// ── Today ────────────────────────────────────────────────────────────────────

export function ConsoleToday() {
  const { data, loading, error, load } = useOverview();
  const actions = useConsoleActions(load);

  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-10 justify-center">
        {error ? <span className="text-red-600">{error}</span> : <><Loader2 className="h-4 w-4 animate-spin" /> Loading today's numbers…</>}
      </div>
    );
  }

  const st = LEVEL_STYLE[data.level];
  const flagged = data.signals.filter(s => s.level === 'red' || s.level === 'amber');
  const needsAction = flagged.filter(s => !s.snoozedUntil);
  const snoozed = flagged.filter(s => s.snoozedUntil);
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
                {data.level === 'unknown' ? 'Not enough data yet'
                  : needsAction.length === 0 ? 'Everything is healthy'
                  : `${needsAction.length} thing${needsAction.length === 1 ? '' : 's'} need${needsAction.length === 1 ? 's' : ''} attention`}
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
          <CardContent>{needsAction.map(s => <SignalRow key={s.key} s={s} data={data} actions={actions} />)}</CardContent>
        </Card>
      )}

      {snoozed.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base text-gray-500">Snoozed</CardTitle></CardHeader>
          <CardContent>{snoozed.map(s => <SignalRow key={s.key} s={s} data={data} actions={actions} />)}</CardContent>
        </Card>
      )}

      {actions.dialog}
    </div>
  );
}
