import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Loader2, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

const MCP_URL = "https://www.recrutas.ai/api/mcp";

interface ApiToken { id: number; name: string; prefix: string; lastUsedAt: string | null; createdAt: string }

export const claudeCodeCommand = (token: string) =>
  `claude mcp add --transport http recrutas ${MCP_URL} --header "Authorization: Bearer ${token}"`;
export const mcpJsonConfig = (token: string) =>
  JSON.stringify({ mcpServers: { recrutas: { url: MCP_URL, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);

function CopyBlock({ label, value, testId }: { label: string; value: string; testId: string }) {
  const { toast } = useToast();
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); toast({ title: "Copied" }); }
    catch { toast({ title: "Couldn't copy", description: "Select the text and copy it manually.", variant: "destructive" }); }
  };
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-400">{label}</span>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={copy}><Copy className="h-3.5 w-3.5 mr-1" />Copy</Button>
      </div>
      <pre className="text-xs bg-slate-100 dark:bg-slate-800 rounded p-2 overflow-x-auto whitespace-pre" data-testid={testId}>{value}</pre>
    </div>
  );
}

/**
 * Personal access tokens for the Recrutas MCP connector: the candidate's
 * matches, verdicts and applications inside Claude Code, Cursor and other
 * MCP clients. A token is shown once; only its hash is stored.
 */
export function AiConnectorSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const { data: tokens = [] } = useQuery<ApiToken[]>({ queryKey: ["/api/account/api-tokens"] });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/account/api-tokens"] });

  const create = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/account/api-tokens", { name: name || "AI tool" })).json(),
    onSuccess: (r: { token: string }) => { setNewToken(r.token); setName(""); refresh(); },
    onError: (e: Error) => toast({ title: "Couldn't create a token", description: e.message, variant: "destructive" }),
  });
  const revoke = useMutation({
    mutationFn: async (id: number) => (await apiRequest("DELETE", `/api/account/api-tokens/${id}`)).json(),
    onSuccess: () => { toast({ title: "Token revoked", description: "Tools using it lose access right away." }); refresh(); },
  });

  return (
    <div className="space-y-3" data-testid="ai-connector-settings">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Connect your AI tools</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Use your matches, verdicts and applications from Claude Code, Cursor or any MCP client: "which of my matches should I apply to?",
          "what happened to my applications?". Your AI tool can read your Recrutas data and record that you applied; it can never apply for you.
        </p>
      </div>

      {newToken ? (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-3">
          <p className="text-xs font-medium text-amber-900 dark:text-amber-200">Copy this now: it won't be shown again. Anyone with it can read your Recrutas data, so keep it private.</p>
          <CopyBlock label="Claude Code: run in your terminal" value={claudeCodeCommand(newToken)} testId="connector-claude-code" />
          <CopyBlock label="Cursor and other MCP clients: add to your MCP config" value={mcpJsonConfig(newToken)} testId="connector-json" />
          <div className="flex justify-end"><Button size="sm" variant="outline" onClick={() => setNewToken(null)}>Done</Button></div>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <div className="grid gap-1.5 flex-1">
            <Label htmlFor="connector-name" className="text-xs">Token name</Label>
            <Input id="connector-name" className="h-9" placeholder="Claude Code on my laptop" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <KeyRound className="h-4 w-4 mr-1.5" />}Create token
          </Button>
        </div>
      )}

      {tokens.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between py-2">
              <div>
                <div className="text-slate-900 dark:text-slate-100">{t.name} <span className="font-mono text-xs text-slate-500">{t.prefix}…</span></div>
                <div className="text-xs text-slate-500">
                  {t.lastUsedAt ? `Last used ${formatDistanceToNow(new Date(t.lastUsedAt), { addSuffix: true })}` : "Never used"}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => revoke.mutate(t.id)} aria-label={`Revoke ${t.name}`}><Trash2 className="h-4 w-4" /></Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
