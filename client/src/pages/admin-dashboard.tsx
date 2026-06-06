import { useState, useEffect, lazy, Suspense } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, ShieldCheck, AlertTriangle, Building2, Users, Briefcase, Target, BarChart3, Settings, Bug, KeyRound, Copy, Plus, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const MetricsContent = lazy(() => import("@/pages/metrics-dashboard").then(m => ({ default: m.MetricsContent })));

type AdminTab = 'overview' | 'metrics' | 'errors' | 'invites';

interface PlatformStats {
  totalJobs: number;
  totalUsers: number;
  totalMatches: number;
}

interface GhostJobStats {
  totalChecked: number;
  ghostsFound: number;
  deactivated: number;
  lastRun?: string;
}

interface CompanyVerificationStats {
  totalCompanies: number;
  verified: number;
  unverified: number;
  lastRun?: string;
}

interface PipelineHealth {
  pipeline: string;
  status: 'ok' | 'warning' | 'failed' | 'stale' | 'never';
  lastRunStatus: string | null;
  lastRunAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
  expectedMaxAgeMinutes: number | null;
  itemsProcessed: number | null;
  itemsFailed: number | null;
  durationMs: number | null;
  message: string | null;
}

const PIPELINE_STATUS_STYLE: Record<PipelineHealth['status'], { dot: string; label: string; text: string }> = {
  ok:      { dot: 'bg-green-500',  label: 'OK',       text: 'text-green-700 dark:text-green-400' },
  warning: { dot: 'bg-yellow-500', label: 'Throttled', text: 'text-yellow-700 dark:text-yellow-400' },
  failed:  { dot: 'bg-red-500',    label: 'Failed',   text: 'text-red-700 dark:text-red-400' },
  stale:   { dot: 'bg-red-500',    label: 'Stale',    text: 'text-red-700 dark:text-red-400' },
  never:   { dot: 'bg-gray-400',   label: 'No runs',  text: 'text-gray-500' },
};

function formatAge(min: number | null): string {
  if (min == null) return '—';
  if (min < 60) return `${min}m ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / (60 * 24))}d ago`;
}

export default function AdminDashboard() {
  const { toast } = useToast();
  const [secret, setSecret] = useState(() => sessionStorage.getItem('admin_secret') || '');
  const [authenticated, setAuthenticated] = useState(!!sessionStorage.getItem('admin_secret'));
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');

  const [platformStats, setPlatformStats] = useState<PlatformStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const [ghostStats, setGhostStats] = useState<GhostJobStats | null>(null);
  const [ghostRunning, setGhostRunning] = useState(false);
  const [ghostFetching, setGhostFetching] = useState(false);

  const [verifyStats, setVerifyStats] = useState<CompanyVerificationStats | null>(null);
  const [verifyRunning, setVerifyRunning] = useState(false);
  const [verifyFetching, setVerifyFetching] = useState(false);

  const [pipelineHealth, setPipelineHealth] = useState<PipelineHealth[] | null>(null);
  const [pipelineFetching, setPipelineFetching] = useState(false);

  // Error monitoring state
  const [errors, setErrors] = useState<any[] | null>(null);
  const [groupedErrors, setGroupedErrors] = useState<any[] | null>(null);
  const [errorsLoading, setErrorsLoading] = useState(false);
  const [errorLevelFilter, setErrorLevelFilter] = useState('all');

  // Invite codes state
  const [inviteCodes, setInviteCodes] = useState<any[] | null>(null);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [createMode, setCreateMode] = useState<'single' | 'batch'>('single');
  const [newCode, setNewCode] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newRole, setNewRole] = useState('any');
  const [newMaxUses, setNewMaxUses] = useState(1);
  const [batchCount, setBatchCount] = useState(5);
  const [batchPrefix, setBatchPrefix] = useState('REC');
  const [creating, setCreating] = useState(false);

  const adminHeaders = {
    'Content-Type': 'application/json',
    'x-admin-secret': secret,
  };

  async function handleAuth() {
    if (!secret.trim()) return;
    try {
      const res = await fetch('/api/admin/ghost-job-stats', { headers: adminHeaders });
      if (res.status === 401) {
        toast({ title: 'Invalid admin secret', variant: 'destructive' });
        return;
      }
      sessionStorage.setItem('admin_secret', secret);
      setAuthenticated(true);
    } catch {
      toast({ title: 'Connection error', variant: 'destructive' });
    }
  }

  // Auto-load data when authenticated and switching tabs
  useEffect(() => {
    if (!authenticated) return;
    if (activeTab === 'overview') {
      loadPlatformStats();
      loadGhostStats();
      loadVerifyStats();
      loadPipelineHealth();
    } else if (activeTab === 'errors') {
      loadErrors();
    } else if (activeTab === 'invites') {
      loadInviteCodes();
    }
  }, [authenticated, activeTab]);

  async function loadPlatformStats() {
    setStatsLoading(true);
    try {
      const res = await fetch('/api/platform/stats');
      if (res.ok) {
        const data = await res.json();
        setPlatformStats({
          totalJobs: data.totalJobs ?? data.jobs ?? 0,
          totalUsers: data.totalUsers ?? data.users ?? 0,
          totalMatches: data.totalMatches ?? data.matches ?? 0,
        });
      }
    } catch {
      // ignore
    } finally {
      setStatsLoading(false);
    }
  }

  async function loadGhostStats() {
    setGhostFetching(true);
    try {
      const res = await fetch('/api/admin/ghost-job-stats', { headers: adminHeaders });
      if (res.ok) setGhostStats(await res.json());
    } catch {
      // ignore
    } finally {
      setGhostFetching(false);
    }
  }

  async function runGhostDetection() {
    setGhostRunning(true);
    try {
      const res = await fetch('/api/admin/run-ghost-job-detection', {
        method: 'POST',
        headers: adminHeaders,
      });
      if (res.status === 401) {
        toast({ title: 'Unauthorized — re-enter admin secret', variant: 'destructive' });
        setAuthenticated(false);
        return;
      }
      const data = await res.json();
      toast({ title: 'Ghost job detection complete', description: data.message || 'Done' });
      loadGhostStats();
    } catch {
      toast({ title: 'Detection failed', variant: 'destructive' });
    } finally {
      setGhostRunning(false);
    }
  }

  async function loadVerifyStats() {
    setVerifyFetching(true);
    try {
      const res = await fetch('/api/admin/company-verification-stats', { headers: adminHeaders });
      if (res.ok) setVerifyStats(await res.json());
    } catch {
      // ignore
    } finally {
      setVerifyFetching(false);
    }
  }

  async function loadPipelineHealth() {
    setPipelineFetching(true);
    try {
      const res = await fetch('/api/admin/pipeline-health', { headers: adminHeaders });
      if (res.ok) setPipelineHealth(await res.json());
    } catch {
      // ignore
    } finally {
      setPipelineFetching(false);
    }
  }

  async function runCompanyVerification() {
    setVerifyRunning(true);
    try {
      const res = await fetch('/api/admin/run-company-verification', {
        method: 'POST',
        headers: adminHeaders,
      });
      if (res.status === 401) {
        toast({ title: 'Unauthorized — re-enter admin secret', variant: 'destructive' });
        setAuthenticated(false);
        return;
      }
      const data = await res.json();
      toast({ title: 'Company verification complete', description: data.message || 'Done' });
      loadVerifyStats();
    } catch {
      toast({ title: 'Verification failed', variant: 'destructive' });
    } finally {
      setVerifyRunning(false);
    }
  }

  async function loadErrors(level?: string) {
    setErrorsLoading(true);
    try {
      const params = new URLSearchParams();
      const filterLevel = level ?? errorLevelFilter;
      if (filterLevel && filterLevel !== 'all') params.set('level', filterLevel);
      params.set('limit', '100');
      const res = await fetch(`/api/admin/errors?${params}`, { headers: adminHeaders });
      if (res.ok) {
        const data = await res.json();
        setErrors(data.errors || []);
        setGroupedErrors(data.grouped || []);
      }
    } catch {
      // ignore
    } finally {
      setErrorsLoading(false);
    }
  }

  async function loadInviteCodes() {
    setInvitesLoading(true);
    try {
      const res = await fetch('/api/admin/invite-codes', { headers: adminHeaders });
      if (res.ok) setInviteCodes(await res.json());
    } catch {
      // ignore
    } finally {
      setInvitesLoading(false);
    }
  }

  async function createInviteCode() {
    setCreating(true);
    try {
      const body = createMode === 'batch'
        ? { count: batchCount, prefix: batchPrefix, description: newDescription || undefined, role: newRole, maxUses: newMaxUses }
        : { code: newCode, description: newDescription || undefined, role: newRole, maxUses: newMaxUses };
      const res = await fetch('/api/admin/invite-codes', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        toast({ title: 'Unauthorized', variant: 'destructive' });
        setAuthenticated(false);
        return;
      }
      const data = await res.json();
      if (createMode === 'batch') {
        toast({ title: `Created ${data.created} codes`, description: data.codes?.join(', ') });
      } else {
        toast({ title: 'Invite code created', description: data.code });
      }
      setNewCode('');
      setNewDescription('');
      loadInviteCodes();
    } catch {
      toast({ title: 'Failed to create', variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  }

  function handleSignOut() {
    sessionStorage.removeItem('admin_secret');
    setAuthenticated(false);
    setSecret('');
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-blue-600" />
              Admin Access
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              type="password"
              placeholder="Admin secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAuth()}
            />
            <Button className="w-full" onClick={handleAuth} disabled={!secret.trim()}>
              Authenticate
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const tabs: { id: AdminTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <Settings className="h-4 w-4" /> },
    { id: 'metrics', label: 'Metrics', icon: <BarChart3 className="h-4 w-4" /> },
    { id: 'errors', label: 'Errors', icon: <Bug className="h-4 w-4" /> },
    { id: 'invites', label: 'Invites', icon: <KeyRound className="h-4 w-4" /> },
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Sticky header with tabs */}
      <div className="sticky top-0 z-40 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-blue-600" />
              <h1 className="text-lg font-bold text-gray-900 dark:text-white">Admin</h1>
            </div>
            <Button variant="ghost" size="sm" onClick={handleSignOut} className="text-gray-500 hover:text-red-600">
              Sign Out
            </Button>
          </div>
          <div className="flex gap-1 -mb-px overflow-x-auto">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab content */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Pipeline (cron) Health */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Clock className="h-5 w-5 text-blue-600" />
                    Pipeline Health
                  </span>
                  <Button variant="outline" size="sm" onClick={loadPipelineHealth} disabled={pipelineFetching}>
                    {pipelineFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {pipelineHealth ? (
                  <div className="space-y-2">
                    {pipelineHealth.map((p) => {
                      const style = PIPELINE_STATUS_STYLE[p.status] ?? PIPELINE_STATUS_STYLE.never;
                      return (
                        <div key={p.pipeline} className="flex items-center gap-3 py-2 border-b border-gray-100 dark:border-gray-800 last:border-0">
                          <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${style.dot}`} title={style.label} />
                          <div className="w-44 shrink-0">
                            <div className="font-mono text-sm font-medium">{p.pipeline}</div>
                            <div className={`text-xs ${style.text}`}>{style.label}</div>
                          </div>
                          <div className="w-24 shrink-0 text-sm text-gray-500" title={p.lastRunAt ?? ''}>
                            {formatAge(p.ageMinutes)}
                          </div>
                          <div className="flex-1 min-w-0 text-xs text-gray-600 dark:text-gray-400 truncate" title={p.message ?? ''}>
                            {p.message ?? 'no runs recorded yet'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-24">
                    {pipelineFetching ? (
                      <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                    ) : (
                      <Button onClick={loadPipelineHealth}>Load Pipeline Health</Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Platform Stats */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>Platform Stats</span>
                  <Button variant="outline" size="sm" onClick={loadPlatformStats} disabled={statsLoading}>
                    {statsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {platformStats ? (
                  <div className="grid grid-cols-3 gap-4">
                    <div className="text-center p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                      <Briefcase className="h-6 w-6 text-blue-600 mx-auto mb-2" />
                      <div className="text-2xl font-bold">{platformStats.totalJobs.toLocaleString()}</div>
                      <div className="text-sm text-gray-500">Total Jobs</div>
                    </div>
                    <div className="text-center p-4 bg-green-50 dark:bg-green-900/20 rounded-lg">
                      <Users className="h-6 w-6 text-green-600 mx-auto mb-2" />
                      <div className="text-2xl font-bold">{platformStats.totalUsers.toLocaleString()}</div>
                      <div className="text-sm text-gray-500">Total Users</div>
                    </div>
                    <div className="text-center p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                      <Target className="h-6 w-6 text-purple-600 mx-auto mb-2" />
                      <div className="text-2xl font-bold">{platformStats.totalMatches.toLocaleString()}</div>
                      <div className="text-sm text-gray-500">Total Matches</div>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-24">
                    {statsLoading ? (
                      <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                    ) : (
                      <Button onClick={loadPlatformStats}>Load Stats</Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Ghost Job Detection */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-orange-500" />
                  Ghost Job Detection
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Button onClick={runGhostDetection} disabled={ghostRunning} className="bg-orange-600 hover:bg-orange-700">
                    {ghostRunning ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Running...</>
                    ) : (
                      'Run Detection'
                    )}
                  </Button>
                  <Button variant="outline" onClick={loadGhostStats} disabled={ghostFetching}>
                    {ghostFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh Stats'}
                  </Button>
                </div>

                {ghostFetching && !ghostStats && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[1, 2, 3, 4].map(i => (
                      <div key={i} className="bg-gray-100 dark:bg-gray-800 rounded-lg p-3 text-center animate-pulse">
                        <div className="h-6 w-10 bg-gray-300 dark:bg-gray-600 rounded mx-auto mb-1" />
                        <div className="h-3 w-16 bg-gray-300 dark:bg-gray-600 rounded mx-auto" />
                      </div>
                    ))}
                  </div>
                )}
                {ghostStats && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { label: 'Checked', value: ghostStats.totalChecked ?? '—', color: 'bg-gray-100 dark:bg-gray-800' },
                      { label: 'Ghosts Found', value: ghostStats.ghostsFound ?? '—', color: 'bg-orange-50 dark:bg-orange-900/20' },
                      { label: 'Deactivated', value: ghostStats.deactivated ?? '—', color: 'bg-red-50 dark:bg-red-900/20' },
                      { label: 'Last Run', value: ghostStats.lastRun ? new Date(ghostStats.lastRun).toLocaleDateString() : 'Never', color: 'bg-blue-50 dark:bg-blue-900/20' },
                    ].map(({ label, value, color }) => (
                      <div key={label} className={`${color} rounded-lg p-3 text-center`}>
                        <div className="text-lg font-bold">{value}</div>
                        <div className="text-xs text-gray-500">{label}</div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Company Verification */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-green-600" />
                  Company Verification
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Button onClick={runCompanyVerification} disabled={verifyRunning} className="bg-green-600 hover:bg-green-700">
                    {verifyRunning ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Running...</>
                    ) : (
                      'Run Verification'
                    )}
                  </Button>
                  <Button variant="outline" onClick={loadVerifyStats} disabled={verifyFetching}>
                    {verifyFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh Stats'}
                  </Button>
                </div>

                {verifyFetching && !verifyStats && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[1, 2, 3, 4].map(i => (
                      <div key={i} className="bg-gray-100 dark:bg-gray-800 rounded-lg p-3 text-center animate-pulse">
                        <div className="h-6 w-10 bg-gray-300 dark:bg-gray-600 rounded mx-auto mb-1" />
                        <div className="h-3 w-16 bg-gray-300 dark:bg-gray-600 rounded mx-auto" />
                      </div>
                    ))}
                  </div>
                )}
                {verifyStats && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { label: 'Total Companies', value: verifyStats.totalCompanies ?? '—', color: 'bg-gray-100 dark:bg-gray-800' },
                      { label: 'Verified', value: verifyStats.verified ?? '—', color: 'bg-green-50 dark:bg-green-900/20' },
                      { label: 'Unverified', value: verifyStats.unverified ?? '—', color: 'bg-yellow-50 dark:bg-yellow-900/20' },
                      { label: 'Last Run', value: verifyStats.lastRun ? new Date(verifyStats.lastRun).toLocaleDateString() : 'Never', color: 'bg-blue-50 dark:bg-blue-900/20' },
                    ].map(({ label, value, color }) => (
                      <div key={label} className={`${color} rounded-lg p-3 text-center`}>
                        <div className="text-lg font-bold">{value}</div>
                        <div className="text-xs text-gray-500">{label}</div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === 'metrics' && (
          <Suspense fallback={
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          }>
            <MetricsContent secret={secret} />
          </Suspense>
        )}

        {activeTab === 'errors' && (
          <div className="space-y-6">
            {/* Controls */}
            <div className="flex items-center gap-3">
              <Select value={errorLevelFilter} onValueChange={(v) => { setErrorLevelFilter(v); loadErrors(v); }}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Filter level" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All levels</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="fatal">Fatal</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => loadErrors()} disabled={errorsLoading}>
                {errorsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
              </Button>
            </div>

            {/* Grouped errors (top errors last 24h) */}
            {groupedErrors && groupedErrors.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Top Errors (24h)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {groupedErrors.map((g: any, i: number) => (
                      <div key={i} className="flex items-start justify-between gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant={g.level === 'fatal' ? 'destructive' : g.level === 'error' ? 'destructive' : 'secondary'} className="text-xs">
                              {g.level}
                            </Badge>
                            {g.component && <span className="text-xs text-gray-500 font-mono">{g.component}</span>}
                          </div>
                          <p className="text-sm font-medium truncate">{g.message}</p>
                          <p className="text-xs text-gray-400 font-mono mt-1">{g.fingerprint}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-lg font-bold text-red-600">{g.count}x</div>
                          <div className="text-xs text-gray-500 flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {g.last_seen ? new Date(g.last_seen).toLocaleTimeString() : '—'}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Individual errors */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  <span>Recent Errors</span>
                  {errors && <span className="text-sm font-normal text-gray-500">{errors.length} entries</span>}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {errorsLoading && !errors ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                  </div>
                ) : errors && errors.length > 0 ? (
                  <div className="space-y-2 max-h-[600px] overflow-y-auto">
                    {errors.map((err: any, i: number) => (
                      <div key={err.id || i} className="p-3 border border-gray-200 dark:border-gray-700 rounded-lg text-sm">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant={err.level === 'fatal' || err.level === 'error' ? 'destructive' : 'secondary'} className="text-xs">
                            {err.level}
                          </Badge>
                          {err.component && <span className="text-xs font-mono text-gray-500">{err.component}</span>}
                          <span className="text-xs text-gray-400 ml-auto">
                            {err.createdAt ? new Date(err.createdAt).toLocaleString() : err.created_at ? new Date(err.created_at).toLocaleString() : '—'}
                          </span>
                        </div>
                        <p className="font-medium">{err.message}</p>
                        {err.stack && (
                          <pre className="mt-2 text-xs text-gray-500 bg-gray-50 dark:bg-gray-900 p-2 rounded overflow-x-auto max-h-32">{err.stack}</pre>
                        )}
                        {err.metadata && (
                          <pre className="mt-1 text-xs text-gray-400 overflow-x-auto">{typeof err.metadata === 'string' ? err.metadata : JSON.stringify(err.metadata, null, 2)}</pre>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center text-gray-500 py-10">No errors found</p>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === 'invites' && (
          <div className="space-y-6">
            {/* Create invite code */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  Create Invite Code
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Button variant={createMode === 'single' ? 'default' : 'outline'} size="sm" onClick={() => setCreateMode('single')}>
                    Single
                  </Button>
                  <Button variant={createMode === 'batch' ? 'default' : 'outline'} size="sm" onClick={() => setCreateMode('batch')}>
                    Batch
                  </Button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {createMode === 'single' ? (
                    <div>
                      <Label className="text-xs">Code</Label>
                      <Input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="e.g. WELCOME2026" />
                    </div>
                  ) : (
                    <>
                      <div>
                        <Label className="text-xs">Prefix</Label>
                        <Input value={batchPrefix} onChange={(e) => setBatchPrefix(e.target.value)} placeholder="REC" />
                      </div>
                      <div>
                        <Label className="text-xs">Count</Label>
                        <Input type="number" value={batchCount} onChange={(e) => setBatchCount(parseInt(e.target.value) || 1)} min={1} max={100} />
                      </div>
                    </>
                  )}
                  <div>
                    <Label className="text-xs">Description</Label>
                    <Input value={newDescription} onChange={(e) => setNewDescription(e.target.value)} placeholder="Optional note" />
                  </div>
                  <div>
                    <Label className="text-xs">Role</Label>
                    <Select value={newRole} onValueChange={setNewRole}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Any</SelectItem>
                        <SelectItem value="candidate">Candidate</SelectItem>
                        <SelectItem value="talent_owner">Talent Owner</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Max Uses</Label>
                    <Input type="number" value={newMaxUses} onChange={(e) => setNewMaxUses(parseInt(e.target.value) || 1)} min={1} />
                  </div>
                </div>

                <Button onClick={createInviteCode} disabled={creating || (createMode === 'single' && !newCode.trim())}>
                  {creating ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating...</> : createMode === 'batch' ? `Generate ${batchCount} Codes` : 'Create Code'}
                </Button>
              </CardContent>
            </Card>

            {/* List invite codes */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  <span>Invite Codes</span>
                  <Button variant="outline" size="sm" onClick={loadInviteCodes} disabled={invitesLoading}>
                    {invitesLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {invitesLoading && !inviteCodes ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                  </div>
                ) : inviteCodes && inviteCodes.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 dark:border-gray-700 text-left">
                          <th className="pb-2 font-medium">Code</th>
                          <th className="pb-2 font-medium">Role</th>
                          <th className="pb-2 font-medium">Uses</th>
                          <th className="pb-2 font-medium">Description</th>
                          <th className="pb-2 font-medium">Expires</th>
                          <th className="pb-2"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                        {inviteCodes.map((ic: any) => (
                          <tr key={ic.id || ic.code} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                            <td className="py-2 font-mono text-xs">{ic.code}</td>
                            <td className="py-2">
                              <Badge variant="secondary" className="text-xs">{ic.role || 'any'}</Badge>
                            </td>
                            <td className="py-2 text-xs">
                              {ic.currentUses ?? ic.current_uses ?? 0} / {ic.maxUses ?? ic.max_uses ?? '∞'}
                            </td>
                            <td className="py-2 text-xs text-gray-500 max-w-[200px] truncate">{ic.description || '—'}</td>
                            <td className="py-2 text-xs text-gray-500">
                              {ic.expiresAt || ic.expires_at ? new Date(ic.expiresAt || ic.expires_at).toLocaleDateString() : 'Never'}
                            </td>
                            <td className="py-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  navigator.clipboard.writeText(ic.code);
                                  toast({ title: 'Copied!', description: ic.code });
                                }}
                              >
                                <Copy className="h-3 w-3" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-center text-gray-500 py-10">No invite codes yet</p>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
