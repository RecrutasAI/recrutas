import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Band, SectionLabel, PrimaryButton } from "@/components/site/site-shell";

const RULE = "border-neutral-200 dark:border-neutral-800";
const ROLE_SUGGESTIONS = ["software engineer", "it support", "data analyst", "product manager", "nurse", "sales"];

export interface RadarEvent {
  type: "new" | "taken_down" | "reposted";
  at: string;
  title: string;
  company: string;
  location: string | null;
  workType: string | null;
  externalUrl: string | null;
  flags: string[];
}
export interface MarketRadarData {
  scope: "role" | "market";
  live: number;
  openedThisWeek: number;
  takenDownThisWeek: number;
  medianLifetimeDays: number | null;
  lastBoardRead: string | null;
  events: RadarEvent[];
}

const BADGE: Record<RadarEvent["type"], { label: string; cls: string; note: string }> = {
  new: { label: "Opened", cls: "text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:border-emerald-500/30", note: "" },
  taken_down: { label: "Taken down", cls: "text-neutral-600 bg-neutral-100 border-neutral-300 dark:text-neutral-300 dark:bg-neutral-800 dark:border-neutral-700", note: "likely filled" },
  reposted: { label: "Reposted", cls: "text-amber-800 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/30", note: "posted again" },
};

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) {return "";}
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 60) {return `${Math.max(1, mins)}m ago`;}
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const place = (e: RadarEvent) => {
  if (!e.location?.trim()) {return e.workType === "remote" ? "Remote" : "";}
  const parts = e.location.split(/\s*[|;•]\s*/).filter(Boolean);
  return parts.length > 1 ? `${parts[0].trim()} +${parts.length - 1}` : e.location.trim();
};

/** One row per posting: the same role at the same company in several cities is one event with a count. */
export function collapseEvents(events: RadarEvent[]): Array<RadarEvent & { count: number }> {
  const out: Array<RadarEvent & { count: number }> = [];
  for (const e of events) {
    const prev = out.find(o => o.type === e.type && o.title === e.title && o.company === e.company);
    if (prev) {prev.count++;} else {out.push({ ...e, count: 1 });}
  }
  return out;
}

const keyOf = (e: RadarEvent) => `${e.type}|${e.title}|${e.company}|${e.at}`;

/**
 * The homepage radar: real events Recrutas detected on company job boards
 * this week, for a role or the whole market. Postings that opened, were taken
 * down, or came back as reposts, with the hard requirements they state.
 * Refreshes every two minutes; new events slide in.
 */
export function MarketRadar({ onStart }: { onStart: () => void }) {
  const [role, setRole] = useState("");
  const [city, setCity] = useState("");
  const [remote, setRemote] = useState(false);
  const [query, setQuery] = useState({ q: "", location: "", remote: false });
  const seen = useRef<Set<string>>(new Set());

  const radar = useQuery<MarketRadarData>({
    queryKey: ["/api/platform/radar", query],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (query.q) {p.set("q", query.q);}
      if (query.location) {p.set("location", query.location);}
      if (query.remote) {p.set("remote", "1");}
      const res = await fetch(`/api/platform/radar?${p}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {throw new Error(res.status === 429 ? "Lots of searches in a short time. Try again in a minute." : body.message || "The radar is unavailable right now.");}
      return body;
    },
    refetchInterval: 120_000,
    staleTime: 60_000,
    retry: false,
  });

  const rows = useMemo(() => collapseEvents(radar.data?.events ?? []), [radar.data]);
  // Events that arrived after the first load of this query get a highlight.
  const fresh = useMemo(() => {
    const keys = rows.map(r => keyOf(r));
    const firstLoad = seen.current.size === 0;
    const isFresh = new Set(firstLoad ? [] : keys.filter(k => !seen.current.has(k)));
    keys.forEach(k => seen.current.add(k));
    return isFresh;
  }, [rows]);

  const run = (q = role, location = city, r = remote) => {
    seen.current = new Set();
    setQuery({ q: q.trim(), location: location.trim(), remote: r });
  };
  const d = radar.data;
  const label = query.q ? `"${query.q}"${query.location ? ` · ${query.location}` : ""}${query.remote ? " · remote" : ""}` : "all roles";

  return (
    <Band id="live" inner="px-4 sm:px-10 py-14 sm:py-20">
      <style>{`
        @keyframes radar-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
        .radar-row { animation: radar-in .45s ease-out both; }
        @keyframes radar-sweep { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
        .radar-sweep { animation: radar-sweep 3.2s linear infinite; }
        @media (prefers-reduced-motion: reduce) { .radar-row, .radar-sweep { animation: none; } }
      `}</style>
      <SectionLabel>Live radar</SectionLabel>
      <h2 className="text-3xl sm:text-5xl font-semibold tracking-[-0.035em] max-w-3xl mb-3">Watch the job market move.</h2>
      <p className="text-lg text-neutral-600 dark:text-neutral-400 max-w-2xl mb-8">
        We read company job boards around the clock. See what just opened, what just closed, and what's being reposted for your role, with what each job really requires.
      </p>

      <form onSubmit={(e) => { e.preventDefault(); run(); }} className={`grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto_auto] border ${RULE}`}>
        <label className="sr-only" htmlFor="radar-role">Role</label>
        <input id="radar-role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Your role, e.g. it support" maxLength={60}
          className={`h-12 px-4 bg-transparent text-[15px] outline-none placeholder:text-neutral-400 border-b sm:border-b-0 sm:border-r ${RULE}`} />
        <label className="sr-only" htmlFor="radar-city">City</label>
        <input id="radar-city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="City (optional)" maxLength={40}
          className={`h-12 px-4 bg-transparent text-[15px] outline-none placeholder:text-neutral-400 border-b sm:border-b-0 sm:border-r ${RULE}`} />
        <button type="button" aria-pressed={remote} onClick={() => setRemote(!remote)}
          className={`h-12 px-4 font-geist-mono text-[11px] uppercase tracking-[0.14em] border-b sm:border-b-0 sm:border-r ${RULE} transition-colors ${remote ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400" : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"}`}>
          {remote ? "✓ " : ""}Remote only
        </button>
        <button type="submit" className="h-12 px-6 bg-emerald-600 text-white text-[15px] font-medium hover:bg-emerald-500 transition-colors">Track</button>
      </form>
      <div className="flex flex-wrap gap-2 mt-3">
        {ROLE_SUGGESTIONS.map((sug) => (
          <button key={sug} onClick={() => { setRole(sug); run(sug); }}
            className={`px-2.5 h-7 border ${RULE} font-geist-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500 hover:text-neutral-900 dark:hover:text-white hover:border-neutral-900 dark:hover:border-white transition-colors`}>
            {sug}
          </button>
        ))}
      </div>

      <div className={`mt-8 border ${RULE} bg-white dark:bg-black`} data-testid="market-radar">
        {/* Status bar: what we're watching and when boards were last read. */}
        <div className={`relative overflow-hidden flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b ${RULE}`}>
          <div aria-hidden className="radar-sweep pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-emerald-500/10 to-transparent" />
          <div className="relative flex items-center gap-2 font-geist-mono text-[11px] uppercase tracking-[0.14em]">
            <span className="relative flex w-2 h-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60 animate-ping" />
              <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
            </span>
            Watching {label}
          </div>
          <span className="relative font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
            {d?.lastBoardRead ? `boards read ${ago(d.lastBoardRead)}` : "reading boards…"}
          </span>
        </div>

        {radar.isError ? (
          <p className="px-5 py-8 text-sm text-red-600 dark:text-red-400" role="alert">{(radar.error as Error).message}</p>
        ) : !d ? (
          <p className="px-5 py-10 font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">Reading company boards…</p>
        ) : (
          <>
            <dl className={`grid grid-cols-2 sm:grid-cols-4 border-b ${RULE}`}>
              {[
                [d.live.toLocaleString(), "live now"],
                [`+${d.openedThisWeek.toLocaleString()}`, "opened this week"],
                [`−${d.takenDownThisWeek.toLocaleString()}`, "taken down this week"],
                [typeof d.medianLifetimeDays === "number" ? `${d.medianLifetimeDays}d` : "—", "a posting usually lasts"],
              ].map(([v, l], i) => (
                <div key={l} className={`px-4 sm:px-5 py-4 ${i % 2 ? "" : `border-r ${RULE}`} sm:border-r ${RULE} ${i === 3 ? "sm:border-r-0" : ""}`}>
                  <dd className="font-geist-mono text-2xl sm:text-3xl tracking-tight tabular-nums">{v}</dd>
                  <dt className="font-geist-mono text-[10px] sm:text-[11px] uppercase tracking-[0.14em] text-neutral-500 mt-1">{l}</dt>
                </div>
              ))}
            </dl>
            {d.scope === "market" && query.q && (
              <p className="px-4 sm:px-5 py-2 text-sm text-neutral-500 border-b border-neutral-100 dark:border-neutral-900">
                Nothing for "{query.q}" this week, so here's the whole market.
              </p>
            )}
            <ul aria-live="polite" aria-label="Events detected on company job boards">
              {rows.map((e, i) => {
                const b = BADGE[e.type];
                const linked = e.type !== "taken_down" && e.externalUrl;
                const body = (
                  <>
                    <span className="font-geist-mono text-[11px] text-neutral-500 tabular-nums w-14 shrink-0">{ago(e.at)}</span>
                    <span className={`shrink-0 border px-1.5 py-0.5 font-geist-mono text-[10px] uppercase tracking-[0.1em] ${b.cls}`}>{b.label}</span>
                    <span className="min-w-0 flex-1">
                      <span className="text-[15px] font-medium">{e.title}</span>
                      {e.count > 1 && <span className="font-geist-mono text-xs text-neutral-500"> ×{e.count}</span>}
                      <span className="text-sm text-neutral-600 dark:text-neutral-400"> · {e.company}{place(e) ? ` · ${place(e)}` : ""}{b.note ? ` · ${b.note}` : ""}</span>
                      {e.flags.length > 0 && (
                        <span className="flex flex-wrap gap-1 mt-1">
                          {e.flags.map(f => <span key={f} className={`border ${RULE} px-1.5 font-geist-mono text-[10px] uppercase tracking-[0.08em] text-neutral-600 dark:text-neutral-400`}>{f}</span>)}
                        </span>
                      )}
                    </span>
                    {linked && <ArrowUpRight className="w-3.5 h-3.5 text-neutral-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />}
                  </>
                );
                const cls = `group flex items-start gap-3 px-4 sm:px-5 py-3 ${fresh.has(keyOf(e)) ? "bg-emerald-50/70 dark:bg-emerald-500/[0.07]" : ""}`;
                return (
                  <li key={keyOf(e)} className={`radar-row ${i > 0 ? `border-t ${RULE}` : ""}`} style={{ animationDelay: `${Math.min(i, 12) * 70}ms` }}>
                    {linked
                      ? <a href={e.externalUrl!} target="_blank" rel="noopener noreferrer" className={`${cls} hover:bg-emerald-50/60 dark:hover:bg-emerald-500/[0.06] transition-colors`}>{body}</a>
                      : <div className={cls}>{body}</div>}
                  </li>
                );
              })}
              {rows.length === 0 && <li className="px-5 py-8 text-sm text-neutral-500">No events this week. Try a broader role.</li>}
            </ul>
            <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 sm:px-5 py-4 border-t ${RULE} bg-neutral-50 dark:bg-neutral-950`}>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-xl">
                That's the market. Upload your resume to see which of these you'd actually get, and to hear the moment a job you applied to closes.
              </p>
              <PrimaryButton onClick={onStart}>Track my search <ArrowRight className="w-4 h-4" /></PrimaryButton>
            </div>
          </>
        )}
      </div>
    </Band>
  );
}
