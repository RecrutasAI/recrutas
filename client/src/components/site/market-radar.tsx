import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bell, ShieldCheck, Target } from "lucide-react";
import { Band, SectionLabel, PrimaryButton } from "@/components/site/site-shell";

const RULE = "border-neutral-200 dark:border-neutral-800";
const ROLE_SUGGESTIONS = ["software engineer", "it support", "data analyst", "nurse", "sales"];

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
  nextBoardRead?: string;
  events: RadarEvent[];
  series?: { t: string; opened: number; closed: number; live: number }[];
  openedLast24h?: number;
  closedLast24h?: number;
}

export function until(iso: string | undefined, now = Date.now()): string {
  if (!iso) {return "";}
  const mins = Math.max(1, Math.round((new Date(iso).getTime() - now) / 60000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) {return "";}
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 60) {return `${Math.max(1, mins)}m ago`;}
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** One row per posting: the same role at the same company in several cities is one event with a count. */
export function collapseEvents(events: RadarEvent[]): Array<RadarEvent & { count: number }> {
  const out: Array<RadarEvent & { count: number }> = [];
  for (const e of events) {
    const prev = out.find(o => o.type === e.type && o.title === e.title && o.company === e.company);
    if (prev) {prev.count++;} else {out.push({ ...e, count: 1 });}
  }
  return out;
}

const W = 1000, H = 300, LINE_TOP = 16, LINE_BOTTOM = 200, VOL_MID = 250, VOL_HALF = 40;

export interface ChartBar { kind: "opened" | "closed"; x: number; y: number; h: number; w: number }

/** SVG geometry for the index: the live-jobs line and opened/closed volume bars. Pure, for testing. */
export function chartGeometry(series: NonNullable<MarketRadarData["series"]>) {
  if (series.length < 2) {return null;}
  const lives = series.map(s => s.live);
  const lo = Math.min(...lives), hi = Math.max(...lives);
  const pad = Math.max(1, (hi - lo) * 0.12);
  const y = (v: number) => LINE_BOTTOM - ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * (LINE_BOTTOM - LINE_TOP);
  const x = (i: number) => (i / (series.length - 1)) * W;
  const line = series.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s.live).toFixed(1)}`).join(" ");
  const area = `${line} L${W},${LINE_BOTTOM} L0,${LINE_BOTTOM} Z`;
  const maxVol = Math.max(1, ...series.map(s => Math.max(s.opened, s.closed)));
  const barW = Math.max(1.5, W / series.length - 1.5);
  const bars: ChartBar[] = series.flatMap((s, i) => [
    ...(s.opened ? [{ kind: "opened" as const, x: x(i) - barW / 2, y: VOL_MID - (s.opened / maxVol) * VOL_HALF, h: (s.opened / maxVol) * VOL_HALF, w: barW }] : []),
    ...(s.closed ? [{ kind: "closed" as const, x: x(i) - barW / 2, y: VOL_MID, h: (s.closed / maxVol) * VOL_HALF, w: barW }] : []),
  ]);
  const days = series.map((s, i) => ({ i, d: new Date(s.t) })).filter(({ d }) => d.getHours() === 0)
    .map(({ i, d }) => ({ x: x(i), label: d.toLocaleDateString("en-US", { weekday: "short" }) }));
  return { line, area, bars, days, last: { x: W, y: y(lives[lives.length - 1]) }, hi, lo };
}

/**
 * The homepage job index: live jobs over the last 7 days, moving like a stock
 * chart, with what opened and closed each hour and a ticker of real events.
 * Everything shown is real data from company job boards. Below it, what
 * Recrutas does with each movement for the person using it.
 */
export function MarketRadar({ onStart }: { onStart: () => void }) {
  const [role, setRole] = useState("");
  const [query, setQuery] = useState("");

  const radar = useQuery<MarketRadarData>({
    queryKey: ["/api/platform/radar", query],
    queryFn: async () => {
      const res = await fetch(`/api/platform/radar${query ? `?q=${encodeURIComponent(query)}` : ""}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {throw new Error(res.status === 429 ? "Lots of searches in a short time. Try again in a minute." : body.message || "The index is unavailable right now.");}
      return body;
    },
    refetchInterval: 120_000,
    staleTime: 60_000,
    retry: false,
  });

  const d = radar.data;
  const geo = useMemo(() => (d?.series ? chartGeometry(d.series) : null), [d]);
  const ticker = useMemo(() => collapseEvents(d?.events ?? []), [d]);
  const name = d?.scope === "role" && query ? query : "all roles";
  const run = (q: string) => { setRole(q); setQuery(q.trim()); };

  return (
    <Band id="live" inner="px-4 sm:px-10 py-14 sm:py-20">
      <style>{`
        @keyframes idx-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
        .idx-line { stroke-dasharray: 1; animation: idx-draw 2.2s ease-out both; }
        @keyframes idx-fade { from { opacity: 0; } to { opacity: 1; } }
        .idx-fill, .idx-bars { animation: idx-fade 1.6s ease-out .4s both; }
        @keyframes idx-tape { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .idx-tape { animation: idx-tape 60s linear infinite; }
        .idx-tape-wrap:hover .idx-tape { animation-play-state: paused; }
        @media (prefers-reduced-motion: reduce) { .idx-line, .idx-fill, .idx-bars, .idx-tape { animation: none; stroke-dasharray: none; } }
      `}</style>
      <SectionLabel>Live index</SectionLabel>
      <h2 className="text-3xl sm:text-5xl font-semibold tracking-[-0.035em] max-w-3xl mb-3">The job market, live.</h2>
      <p className="text-lg text-neutral-600 dark:text-neutral-400 max-w-2xl mb-8">
        Every hour, jobs open and jobs disappear. We read company job boards around the clock so you see it as it happens, and so you never apply into the void.
      </p>

      <div className={`border ${RULE} bg-white dark:bg-black`} data-testid="market-radar">
        {/* Header: index name, live value, 24h change, sweep status. */}
        <div className="flex flex-wrap items-end justify-between gap-4 px-4 sm:px-6 pt-5 pb-3">
          <div>
            <div className="flex items-center gap-2 font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
              <span className="relative flex w-2 h-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60 animate-ping" />
                <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
              </span>
              Recrutas job index · {name}
            </div>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="font-geist-mono text-4xl sm:text-5xl tracking-tight tabular-nums" data-testid="index-live">{d ? d.live.toLocaleString() : "—"}</span>
              <span className="text-sm text-neutral-500">live jobs</span>
              {d && typeof d.openedLast24h === "number" && (
                <span className="font-geist-mono text-sm tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-400">▲ {d.openedLast24h.toLocaleString()} opened</span>
                  <span className="text-neutral-400"> · </span>
                  <span className="text-red-600 dark:text-red-400">▼ {(d.closedLast24h ?? 0).toLocaleString()} taken down</span>
                  <span className="text-neutral-500"> · 24h</span>
                </span>
              )}
            </div>
          </div>
          <span className="font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
            {d?.lastBoardRead ? `last sweep ${ago(d.lastBoardRead)}${d.nextBoardRead ? ` · next in ${until(d.nextBoardRead)}` : ""}` : "reading boards…"}
          </span>
        </div>

        {/* The chart. */}
        <div className="px-2 sm:px-4">
          {radar.isError ? (
            <p className="px-3 py-16 text-sm text-red-600 dark:text-red-400" role="alert">{(radar.error as Error).message}</p>
          ) : !geo ? (
            <div className="h-[220px] sm:h-[300px] flex items-center justify-center font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">Reading company boards…</div>
          ) : (
            <svg key={query} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-[220px] sm:h-[300px]" role="img"
              aria-label={`Live jobs over the last 7 days for ${name}, from ${geo.lo.toLocaleString()} to ${geo.hi.toLocaleString()}`}>
              <defs>
                <linearGradient id="idx-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[0.25, 0.5, 0.75].map(f => (
                <line key={f} x1="0" x2={W} y1={LINE_TOP + f * (LINE_BOTTOM - LINE_TOP)} y2={LINE_TOP + f * (LINE_BOTTOM - LINE_TOP)} className="stroke-neutral-200 dark:stroke-neutral-800" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              ))}
              <path d={geo.area} fill="url(#idx-grad)" className="idx-fill" />
              <path d={geo.line} pathLength={1} fill="none" stroke="rgb(16 185 129)" strokeWidth="2.2" vectorEffect="non-scaling-stroke" className="idx-line" />
              <g className="idx-bars">
                <line x1="0" x2={W} y1={VOL_MID} y2={VOL_MID} className="stroke-neutral-200 dark:stroke-neutral-800" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                {geo.bars.map((b, i) => (
                  <rect key={i} x={b.x} y={b.y} width={b.w} height={Math.max(1, b.h)} className={b.kind === "opened" ? "fill-emerald-500/80" : "fill-red-500/70"} />
                ))}
              </g>
              {geo.days.map(t => (
                <text key={t.x} x={t.x + 4} y={H - 2} className="fill-neutral-400 font-geist-mono" fontSize="11">{t.label}</text>
              ))}
              <circle cx={geo.last.x - 4} cy={geo.last.y} r="4" fill="rgb(16 185 129)">
                <animate attributeName="r" values="4;7;4" dur="2s" repeatCount="indefinite" />
              </circle>
            </svg>
          )}
        </div>

        {/* Ticker tape of real events. */}
        {ticker.length > 0 && (
          <div className={`idx-tape-wrap overflow-hidden border-y ${RULE} bg-neutral-50 dark:bg-neutral-950`} aria-label="Latest openings and take-downs">
            <div className="idx-tape flex w-max">
              {[0, 1].map(copy => (
                <ul key={copy} className="flex shrink-0" aria-hidden={copy === 1}>
                  {ticker.map((e, i) => (
                    <li key={`${copy}-${i}`} className="flex items-center gap-2 px-5 py-2.5 whitespace-nowrap font-geist-mono text-xs">
                      <span className={e.type === "taken_down" ? "text-red-600 dark:text-red-400" : e.type === "reposted" ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}>
                        {e.type === "taken_down" ? "▼" : e.type === "reposted" ? "↻" : "▲"}
                      </span>
                      <span className="uppercase tracking-[0.08em] text-neutral-900 dark:text-white">{e.company}</span>
                      <span className="text-neutral-600 dark:text-neutral-400">{e.title}{e.count > 1 ? ` ×${e.count}` : ""}</span>
                      <span className="text-neutral-400">{e.type === "taken_down" ? "taken down" : e.type === "reposted" ? "reposted" : "opened"} {ago(e.at)}</span>
                    </li>
                  ))}
                </ul>
              ))}
            </div>
          </div>
        )}

        {/* What Recrutas does with each movement. */}
        <div className="grid sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-neutral-200 dark:divide-neutral-800">
          {[
            { icon: Target, title: "A job opens", body: "We match it to your resume within hours of it appearing." },
            { icon: ShieldCheck, title: "Before you apply", body: "We flag what rules you out: clearance, citizenship, sponsorship, years." },
            { icon: Bell, title: "A job closes", body: "If you applied, we tell you. No more waiting on silence." },
          ].map(v => (
            <div key={v.title} className="px-4 sm:px-6 py-5">
              <div className="flex items-center gap-2 mb-1.5">
                <v.icon className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <h3 className="font-semibold tracking-tight">{v.title}</h3>
              </div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">{v.body}</p>
            </div>
          ))}
        </div>

        <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 sm:px-6 py-4 border-t ${RULE}`}>
          <form onSubmit={(e) => { e.preventDefault(); run(role); }} className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="radar-role">Your role</label>
            <input id="radar-role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="See your role, e.g. nurse" maxLength={60}
              className={`h-9 w-48 px-3 bg-transparent text-sm border ${RULE} outline-none placeholder:text-neutral-400`} />
            {ROLE_SUGGESTIONS.map(s => (
              <button key={s} type="button" onClick={() => run(s)}
                className={`h-7 px-2 border ${RULE} font-geist-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500 hover:text-neutral-900 dark:hover:text-white`}>{s}</button>
            ))}
            {query && <button type="button" onClick={() => run("")} className="h-7 px-2 font-geist-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500 underline">all roles</button>}
          </form>
          <PrimaryButton onClick={onStart}>Track my search <ArrowRight className="w-4 h-4" /></PrimaryButton>
        </div>
        {d?.scope === "market" && query && (
          <p className="px-4 sm:px-6 pb-4 text-sm text-neutral-500">Not much for "{query}" this week, so this is the whole market.</p>
        )}
      </div>
    </Band>
  );
}
