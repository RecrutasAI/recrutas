import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, Pin, Play } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { adminFetch } from '@/lib/admin-fetch';
import { RequestStatus, SignalRow, useConsoleActions, useOverview } from './console-today';

interface SettingRow {
  key: string; value: any; pinned: boolean; updatedBy: string | null; updatedAt: string | null; reason: string | null;
  title: string; help: string;
}
interface AuditEntry { id: number; at: string; actor: string; action: string; target: string | null; detail: any; reason: string | null }

const describe = (key: string, value: any): string => {
  if (typeof value === 'boolean') {return value ? 'On' : 'Off';}
  if (key === 'noticeBanner') {return value ? `"${value.text}" (${value.level})` : 'None';}
  return String(value);
};

function ChangeDialog({ setting, onClose, onSaved }: { setting: SettingRow; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [value, setValue] = useState<any>(typeof setting.value === 'boolean' ? !setting.value : setting.value);
  const [bannerText, setBannerText] = useState(setting.value?.text ?? '');
  const [bannerLevel, setBannerLevel] = useState<'info' | 'warning'>(setting.value?.level ?? 'warning');
  const [reason, setReason] = useState('');
  const [pinned, setPinned] = useState(setting.pinned);
  const [saving, setSaving] = useState(false);

  const next = setting.key === 'noticeBanner' ? (bannerText.trim() ? { text: bannerText.trim(), level: bannerLevel } : null) : value;

  async function save() {
    setSaving(true);
    try {
      const r = await adminFetch(`/api/admin/settings/${setting.key}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: next, reason, pinned }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {throw new Error(body.message || `Save failed (${r.status})`);}
      toast({ title: `${setting.title}: ${describe(setting.key, next)}` });
      onSaved();
    } catch (e: any) {
      toast({ title: 'Not saved', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{setting.title}</DialogTitle>
          <DialogDescription>{setting.help}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {typeof setting.value === 'boolean' && (
            <div className="flex items-center justify-between">
              <Label htmlFor="setting-value">Turn {value ? 'on' : 'off'}</Label>
              <Switch id="setting-value" checked={!!value} onCheckedChange={setValue} />
            </div>
          )}
          {typeof setting.value === 'number' && (
            <div className="space-y-1">
              <Label htmlFor="setting-value">New value</Label>
              <Input id="setting-value" type="number" value={value} onChange={e => setValue(Number(e.target.value))} />
            </div>
          )}
          {setting.key === 'noticeBanner' && (
            <div className="space-y-2">
              <Label htmlFor="banner-text">Banner text (empty removes it)</Label>
              <Input id="banner-text" maxLength={200} value={bannerText} onChange={e => setBannerText(e.target.value)} placeholder="We're busy right now; feeds may take a little longer." />
              <div className="flex gap-2">
                {(['info', 'warning'] as const).map(l => (
                  <Button key={l} type="button" size="sm" variant={bannerLevel === l ? 'default' : 'outline'} onClick={() => setBannerLevel(l)}>{l === 'info' ? 'Info' : 'Warning'}</Button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="setting-reason">Reason (goes in the audit log)</Label>
            <Textarea id="setting-reason" rows={2} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} placeholder="Launch post went out; protecting the feed." />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="setting-pin">Pin it (Autopilot won't change it)</Label>
            <Switch id="setting-pin" checked={pinned} onCheckedChange={setPinned} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || !reason.trim()}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const RUN_STATUS: Record<string, { dot: string; word: string }> = {
  ok: { dot: 'bg-emerald-500', word: 'ok' },
  warning: { dot: 'bg-amber-500', word: 'warning' },
  error: { dot: 'bg-red-500', word: 'failed' },
};

export function ConsoleSystem() {
  const { data, load: loadOverview } = useOverview();
  const [settings, setSettings] = useState<SettingRow[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [editing, setEditing] = useState<SettingRow | null>(null);

  const load = useCallback(async () => {
    const [s, a] = await Promise.all([
      adminFetch('/api/admin/settings').then(r => (r.ok ? r.json() : null)).catch(() => null),
      adminFetch('/api/admin/audit?limit=30').then(r => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (s) { setSettings(s.settings); setAvailable(s.available); }
    if (a) {setAudit(a.entries);}
  }, []);
  useEffect(() => { load(); }, [load]);
  const actions = useConsoleActions(() => { loadOverview(); load(); });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-base">Capacity signals</CardTitle></CardHeader>
        <CardContent>
          {data ? data.signals.map(s => <SignalRow key={s.key} s={s} data={data} actions={actions} />) : <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          <p className="mt-3 text-xs text-gray-500">Thresholds come from docs/scaling-strategy.md, section 5.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scheduled jobs</CardTitle>
          <p className="text-xs text-gray-500">Run any of these now. It starts on the server within a minute, with the same limits as its scheduled run. Backups, purges and emails to users run on their schedule only.</p>
        </CardHeader>
        <CardContent>
          {!data ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : data.jobs.map(j => {
            const last = j.lastRun ? RUN_STATUS[j.lastRun.status] ?? { dot: 'bg-gray-400', word: j.lastRun.status } : null;
            const busy = !!j.request && (j.request.status === 'queued' || j.request.status === 'running');
            return (
              <div key={j.key} className="flex flex-col gap-2 py-3 border-b last:border-b-0 border-gray-100 dark:border-gray-800 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{j.title}</p>
                  <p className="text-xs text-gray-500">{j.description}</p>
                  {j.lastRun && last && (
                    <p className="text-xs text-gray-600 dark:text-gray-300 flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full shrink-0 ${last.dot}`} aria-hidden />
                      <span className="min-w-0 break-words">Last run {new Date(j.lastRun.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {last.word}{j.lastRun.message ? ` · ${j.lastRun.message}` : ''}</span>
                    </p>
                  )}
                  {j.request && <RequestStatus request={j.request} />}
                </div>
                <Button size="sm" variant="outline" className="shrink-0" disabled={busy}
                  onClick={() => actions.runJob(j.key, j.title, j.description, `Run "${j.title}" from Scheduled jobs`)}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}Run now
                </Button>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Switches</CardTitle></CardHeader>
        <CardContent>
          {!available && (
            <p className="mb-3 text-sm text-amber-700 dark:text-amber-300">
              Switches are read-only until the runtime_settings migration runs on the database. These are the defaults.
            </p>
          )}
          {!settings ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : settings.map(s => (
            <div key={s.key} className="flex flex-col gap-2 py-3 border-b last:border-b-0 border-gray-100 dark:border-gray-800 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-2">
                  {s.title}
                  {s.pinned && <span className="inline-flex items-center gap-1 text-xs text-gray-500"><Pin className="h-3 w-3" /> pinned</span>}
                </p>
                <p className="text-xs text-gray-500">{s.help}</p>
                {s.updatedBy && (
                  <p className="text-xs text-gray-400 mt-0.5">
                    {s.updatedBy} · {s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ''}{s.reason ? ` · "${s.reason}"` : ''}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-white">{describe(s.key, s.value)}</span>
                <Button size="sm" variant="outline" disabled={!available} onClick={() => setEditing(s)}>Change</Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Audit log</CardTitle></CardHeader>
        <CardContent>
          {audit.length === 0 ? <p className="text-sm text-gray-500">No admin or Autopilot actions yet.</p> : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {audit.map(e => (
                <li key={e.id} className="py-2 text-sm">
                  <span className="text-gray-500 tabular-nums">{new Date(e.at).toLocaleString()}</span>{' · '}
                  <span className="font-medium text-gray-900 dark:text-white">{e.actor}</span>{' '}
                  {e.action === 'setting.change' && e.target
                    ? <>set <b>{settings?.find(x => x.key === e.target)?.title ?? e.target}</b> from {describe(e.target, e.detail?.from)} to {describe(e.target, e.detail?.to)}</>
                    : e.action === 'job.run' && e.target
                    ? <>ran <b>{data?.jobs.find(j => j.key === e.target)?.title ?? e.target}</b></>
                    : e.action === 'signal.snooze' && e.target
                    ? <>snoozed <b>{data?.signals.find(x => x.key === e.target)?.label ?? e.target}</b> for {e.detail?.hours} h</>
                    : <>{e.action}{e.target ? ` ${e.target}` : ''}</>}
                  {e.reason && <span className="text-gray-500"> · "{e.reason}"</span>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {actions.dialog}
      {editing && <ChangeDialog setting={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}
