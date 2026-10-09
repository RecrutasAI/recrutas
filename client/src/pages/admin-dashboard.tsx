import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, ShieldCheck, Briefcase, Bug, KeyRound, Copy, Plus, Clock, TrendingUp, Sparkles, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { ConsoleToday } from "@/components/admin/console-today";
import { ConsoleSystem } from "@/components/admin/console-system";
import { ConsoleGrowth } from "@/components/admin/console-growth";
import { ConsoleJobs } from "@/components/admin/console-jobs";
import { ConsoleAi } from "@/components/admin/console-ai";
import { adminHeaders as buildAdminHeaders } from "@/lib/admin-fetch";

type AdminTab = 'today' | 'growth' | 'jobs' | 'ai' | 'system' | 'errors' | 'invites';



export default function AdminDashboard() {
  const { toast } = useToast();
  const [secret, setSecret] = useState(() => sessionStorage.getItem('admin_secret') || '');
  // Admins sign in with their Recrutas account (ADMIN_EMAILS); the secret is a fallback for scripts.
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [adminEmail, setAdminEmail] = useState<string | null>(null);
  const [authHeaders, setAuthHeaders] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<AdminTab>('today');


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
    ...authHeaders,
  };

  // Who am I? 200 when signed in with an ADMIN_EMAILS account (or a saved secret).
  async function checkAccess(): Promise<boolean> {
    const headers = await buildAdminHeaders();
    try {
      const res = await fetch('/api/admin/whoami', { headers });
      if (!res.ok) return false;
      const me = await res.json();
      setAuthHeaders(headers);
      setAdminEmail(me.email ?? null);
      setAuthenticated(true);
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    checkAccess().finally(() => setCheckingSession(false));
  }, []);

  async function handleAuth() {
    if (!secret.trim()) return;
    try { sessionStorage.setItem('admin_secret', secret); } catch { /* storage blocked */ }
    if (!(await checkAccess())) {
      try { sessionStorage.removeItem('admin_secret'); } catch { /* storage blocked */ }
      toast({ title: 'Invalid admin secret', variant: 'destructive' });
    }
  }

  // Auto-load data when authenticated and switching tabs
  useEffect(() => {
    if (!authenticated) return;
    if (activeTab === 'errors') {
      loadErrors();
    } else if (activeTab === 'invites') {
      loadInviteCodes();
    }
  }, [authenticated, activeTab]);

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
    try { sessionStorage.removeItem('admin_secret'); } catch { /* storage blocked */ }
    setAuthenticated(false);
    setAuthHeaders({});
    setSecret('');
    window.location.href = '/';
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-blue-600" />
              Admin console
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {checkingSession ? (
              <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Checking your account…</div>
            ) : (
              <>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Sign in to Recrutas with an admin email (listed in ADMIN_EMAILS), then come back to this page.
                </p>
                <Button className="w-full" onClick={() => { window.location.href = '/auth'; }}>Sign in</Button>
                <details className="text-sm">
                  <summary className="cursor-pointer text-gray-500">Use the admin secret instead</summary>
                  <div className="mt-3 space-y-2">
                    <Input
                      type="password"
                      placeholder="Admin secret"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAuth()}
                    />
                    <Button variant="outline" className="w-full" onClick={handleAuth} disabled={!secret.trim()}>
                      Continue
                    </Button>
                  </div>
                </details>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const tabs: { id: AdminTab; label: string; icon: React.ReactNode }[] = [
    { id: 'today', label: 'Today', icon: <Clock className="h-4 w-4" /> },
    { id: 'growth', label: 'Growth', icon: <TrendingUp className="h-4 w-4" /> },
    { id: 'jobs', label: 'Jobs', icon: <Briefcase className="h-4 w-4" /> },
    { id: 'ai', label: 'AI & matching', icon: <Sparkles className="h-4 w-4" /> },
    { id: 'system', label: 'System', icon: <Server className="h-4 w-4" /> },
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
              {adminEmail && <span className="hidden sm:inline text-xs text-gray-500">{adminEmail}</span>}
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
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap shrink-0 border-b-2 transition-colors ${
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
        {activeTab === 'today' && <ConsoleToday />}
        {activeTab === 'system' && <ConsoleSystem />}

        {activeTab === 'growth' && <ConsoleGrowth />}
        {activeTab === 'jobs' && <ConsoleJobs />}
        {activeTab === 'ai' && <ConsoleAi />}

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
