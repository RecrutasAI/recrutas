import { useState, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";
import { SiteShell, Band, SectionLabel } from "@/components/site/site-shell";

const RULE = "border-neutral-200 dark:border-neutral-800";
const MCP_URL = "https://www.recrutas.ai/api/mcp";

const TOOLS: { name: string; does: string; example: string }[] = [
  { name: "search_my_matches", does: "Your live matches (up to 100), each with a match score and an Apply / Stretch / Skip verdict and the reason. Filter by verdict, how recently posted, location or work type.", example: "Which of my matches posted this week should I apply to?" },
  { name: "get_job", does: "One job: what the posting requires, your verdict, whether it's still on the company's careers page, a description excerpt, and the link to apply.", example: "Tell me about #574586. Do I meet the requirements?" },
  { name: "list_my_applications", does: "Everything you applied to and what happened since: still posted, taken down by the company, or reposted.", example: "What happened to my applications?" },
  { name: "record_application", does: "Records that you applied, if the browser extension didn't log it. Your AI tool should only call it after you confirm you submitted.", example: "I applied to #574586." },
  { name: "why_no_replies", does: "A diagnosis of your own applications: replies, take-downs, timing and fit, with one next step.", example: "Why am I not hearing back?" },
];

function Code({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* select manually */ }
  };
  return (
    <div className={`border ${RULE} mt-3`}>
      <div className={`flex items-center justify-between px-4 py-2 border-b ${RULE} font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500`}>
        <span>{label}</span>
        <button type="button" onClick={copy} className="inline-flex items-center gap-1 hover:text-neutral-900 dark:hover:text-white">
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}{copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="px-4 py-3 text-[13px] leading-relaxed overflow-x-auto font-geist-mono text-neutral-800 dark:text-neutral-200">{value}</pre>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className={`p-6 sm:p-7 border-r border-b ${RULE}`}>
      <div className="font-geist-mono text-[11px] text-emerald-600 dark:text-emerald-400 mb-4">STEP 0{n}</div>
      <h3 className="text-lg font-semibold tracking-tight mb-2">{title}</h3>
      <div className="text-neutral-600 dark:text-neutral-400 leading-relaxed">{children}</div>
    </li>
  );
}

export default function DocsPage() {
  return (
    <SiteShell active="docs">
      <Band className="border-t-0" inner="px-4 sm:px-10 pt-16 pb-14 sm:pt-24 sm:pb-16">
        <SectionLabel>developer docs</SectionLabel>
        <h1 className="text-4xl sm:text-6xl font-semibold tracking-[-0.04em] leading-[1.05] max-w-3xl mb-6">
          Recrutas in your AI tools.
        </h1>
        <p className="text-lg sm:text-xl leading-relaxed text-neutral-600 dark:text-neutral-400 max-w-2xl">
          Connect Claude Code, Cursor or any MCP client to your Recrutas account. Ask which of your matches to apply to,
          check a job's requirements, and find out what happened to your applications, without leaving your editor.
        </p>
      </Band>

      <Band id="setup" inner="px-4 sm:px-10 py-14 sm:py-16">
        <SectionLabel>set up</SectionLabel>
        <h2 className="text-3xl sm:text-4xl font-semibold tracking-[-0.035em] mb-8">Three minutes, one token.</h2>
        <ol className={`grid lg:grid-cols-3 border-t border-l ${RULE}`}>
          <Step n={1} title="Have a Recrutas account">
            Sign up at <a className="underline" href="/auth">recrutas.ai</a> and upload your resume, so there are matches to ask about.
          </Step>
          <Step n={2} title="Create a token">
            In your dashboard, open <strong>Settings → Connect your AI tools</strong> and create a token. It's shown once: copy it then.
          </Step>
          <Step n={3} title="Add the connector">
            Run the command below (Claude Code) or add the config (Cursor and other clients). Then ask your assistant about your job search.
          </Step>
        </ol>
        <div className="max-w-3xl mt-10">
          <h3 className="font-semibold tracking-tight">Claude Code</h3>
          <Code label="terminal" value={`claude mcp add --transport http recrutas ${MCP_URL} \\\n  --header "Authorization: Bearer YOUR_TOKEN"`} />
          <h3 className="font-semibold tracking-tight mt-8">Cursor and other MCP clients</h3>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">Add to your client's MCP configuration (for Cursor, <code className="font-geist-mono text-sm">~/.cursor/mcp.json</code>):</p>
          <Code label="mcp.json" value={JSON.stringify({ mcpServers: { recrutas: { url: MCP_URL, headers: { Authorization: "Bearer YOUR_TOKEN" } } } }, null, 2)} />
          <p className="text-neutral-600 dark:text-neutral-400 mt-6 text-sm">
            Any client that speaks MCP over Streamable HTTP and can send a header works: the endpoint is <code className="font-geist-mono">{MCP_URL}</code> with
            {" "}<code className="font-geist-mono">Authorization: Bearer &lt;token&gt;</code>.
          </p>
        </div>
      </Band>

      <Band id="tools" inner="px-4 sm:px-10 py-14 sm:py-16">
        <SectionLabel>tools</SectionLabel>
        <h2 className="text-3xl sm:text-4xl font-semibold tracking-[-0.035em] mb-8">What your assistant can do.</h2>
        <div className={`border-t border-l ${RULE}`}>
          {TOOLS.map((t) => (
            <div key={t.name} className={`grid md:grid-cols-[220px_1fr_1fr] gap-x-6 gap-y-2 p-5 sm:p-6 border-r border-b ${RULE}`}>
              <code className="font-geist-mono text-sm text-emerald-700 dark:text-emerald-400">{t.name}</code>
              <p className="text-neutral-700 dark:text-neutral-300 leading-relaxed">{t.does}</p>
              <p className="text-neutral-500 italic">"{t.example}"</p>
            </div>
          ))}
        </div>
        <p className="text-neutral-600 dark:text-neutral-400 mt-6 max-w-3xl">
          Your assistant can read your matches and applications and record that you applied. <strong>It can never apply for you.</strong> To
          apply, open the job's link: the Recrutas browser extension fills the form, and you review it and submit.
        </p>
      </Band>

      <Band id="security" inner="px-4 sm:px-10 py-14 sm:py-16">
        <SectionLabel>tokens, limits and troubleshooting</SectionLabel>
        <div className="grid md:grid-cols-2 gap-10 max-w-5xl text-neutral-700 dark:text-neutral-300 leading-relaxed">
          <ul className="space-y-3 list-disc pl-5">
            <li>A token gives access to <strong>your</strong> Recrutas data. Keep it private, like a password.</li>
            <li>We store only a hash of each token; we can't show it to you again. Lost it? Create a new one.</li>
            <li>Revoke a token anytime in Settings → Connect your AI tools. It stops working immediately.</li>
            <li>Up to 10 active tokens per account, and 500 requests per account per day.</li>
          </ul>
          <ul className="space-y-3 list-disc pl-5">
            <li><strong>401 "Missing or invalid Recrutas token":</strong> the header is missing, mistyped, or the token was revoked.</li>
            <li><strong>429:</strong> the daily limit is reached. It resets at midnight UTC.</li>
            <li><strong>No matches:</strong> upload a resume at recrutas.ai first; matches come from it.</li>
            <li>Verdicts say "Check" until you answer a few questions in Settings → Application answers.</li>
          </ul>
        </div>
      </Band>
    </SiteShell>
  );
}
