import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { Band, SectionLabel, PrimaryButton } from "@/components/site/site-shell";
import { ago, until, collapseEvents, interleave, type RadarEvent } from "@/components/site/market-radar";
import { track } from "@/lib/analytics";

const RULE = "border-neutral-200 dark:border-neutral-800";
const ROLES = ["software engineer", "it support", "data analyst", "nurse", "sales", "product manager"];
import { DEMO_ANSWERS_KEY } from "@/lib/demo-answers";

type YN = "yes" | "no" | "";
interface Facts { citizen: YN; sponsorship: YN; clearance: YN; years: string }
type Verdict = { label: "apply" | "stretch" | "skip" | "closed"; reason: string };
export interface PersonalMarketData {
  scope: "role" | "market";
  live: number;
  answered: boolean;
  eligible: number | null;
  restrictedShare: number;
  shutOut: { citizenship: number; clearance: number; sponsorship: number; years: number };
  openedLast24h: number;
  closedLast24h: number;
  sparkline: number[];
  lastBoardRead: string | null;
  nextBoardRead: string;
  events: Array<RadarEvent & { verdict: Verdict }>;
}

export function oneIn(share: number): string {
  if (share <= 0) {return "";}
  return `1 in ${Math.max(2, Math.round(1 / share))}`;
}

/** The shut-out reasons worth showing, largest first. */
export function shutOutChips(s: PersonalMarketData["shutOut"]): string[] {
  return ([
    [s.citizenship, "need US citizenship"],
    [s.sponsorship, "won't sponsor a visa"],
    [s.years, "want more years"],
    [s.clearance, "need a security clearance"],
  ] as const).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0]).map(([n, l]) => `${n.toLocaleString()} ${l}`);
}

const VERDICT_STYLE: Record<Verdict["label"], { text: string; cls: string }> = {
  apply: { text: "Open to you", cls: "text-emerald-700 border-emerald-200 bg-emerald-50 dark:text-emerald-300 dark:border-emerald-500/30 dark:bg-emerald-500/10" },
  stretch: { text: "Stretch", cls: "text-amber-800 border-amber-200 bg-amber-50 dark:text-amber-300 dark:border-amber-500/30 dark:bg-amber-500/10" },
  skip: { text: "Not for you", cls: "text-neutral-700 border-neutral-300 bg-neutral-100 dark:text-neutral-300 dark:border-neutral-700 dark:bg-neutral-800" },
  closed: { text: "Closed", cls: "text-red-700 border-red-200 bg-red-50 dark:text-red-300 dark:border-red-500/30 dark:bg-red-500/10" },
};

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {return null;}
  const lo = Math.min(...values), hi = Math.max(...values), span = Math.max(1, hi - lo);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - lo) / span) * 24}`).join(" ");
  return (
    <svg viewBox="0 0 100 32" className="w-24 h-8" aria-hidden preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="rgb(16 185 129)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Toggle({ label, value, onChange, id }: { label: string; value: YN; onChange: (v: YN) => void; id: string }) {
  return (
    <div className="flex items-center gap-2" role="group" aria-labelledby={id}>
      <span id={id} className="text-sm text-neutral-600 dark:text-neutral-400">{label}</span>
      {(["yes", "no"] as const).map(v => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(value === v ? "" : v)}
          className={`h-8 px-3 border ${RULE} text-sm capitalize transition-colors ${value === v ? "bg-emerald-600 border-emerald-600 text-white" : "hover:border-neutral-900 dark:hover:border-white"}`}>
          {v}
        </button>
      ))}
    </div>
  );
}

/**
 * The homepage demo: how many live jobs this visitor can actually apply to.
 * They name a role and, optionally, a few facts (nothing is stored on our
 * side); we check every live job's stated requirements and show what's open to
 * them, what shuts them out, and what's moving right now with a verdict for
 * them on each job. The answers carry into sign-up so the dashboard starts
 * where the demo left off.
 */
export function PersonalMarket({ onStart }: { onStart: () => void }) {
  const [roleInput, setRoleInput] = useState("");
  const [role, setRole] = useState("");
  const [facts, setFacts] = useState<Facts>({ citizen: "", sponsorship: "", clearance: "", years: "" });
  const setFact = <K extends keyof Facts>(k: K, v: Facts[K]) => {
    setFacts(f => ({ ...f, [k]: v }));
    track("demo_answer_set", { field: k });
  };

  const params = useMemo(() => {
    const p = new URLSearchParams({ q: role });
    if (facts.citizen) {p.set("citizen", facts.citizen);}
    if (facts.sponsorship) {p.set("sponsorship", facts.sponsorship);}
    if (facts.clearance) {p.set("clearance", facts.clearance);}
    if (facts.years.trim() !== "" && Number.isFinite(Number(facts.years))) {p.set("years", String(Math.round(Number(facts.years))));}
    return p.toString();
  }, [role, facts]);

  const market = useQuery<PersonalMarketData>({
    queryKey: ["/api/platform/my-market", params],
    enabled: !!role,
    queryFn: async () => {
      const res = await fetch(`/api/platform/my-market?${params}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {throw new Error(res.status === 429 ? "Lots of searches in a short time. Try again in a minute." : body.message || "This is unavailable right now.");}
      return body;
    },
    placeholderData: prev => prev,
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  });

  const d = market.data;
  const stream = useMemo(() => interleave(collapseEvents(d?.events ?? []) as Array<RadarEvent & { verdict: Verdict; count: number }>), [d]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(0);
    if (stream.length < 2) {return;}
    const id = setInterval(() => setTick(t => t + 1), 3400);
    return () => clearInterval(id);
  }, [stream]);
  const current = stream.length ? stream[tick % stream.length] : null;

  const pick = (r: string) => {
    const v = r.trim();
    if (v.length < 2) {return;}
    setRoleInput(v);
    setRole(v);
    track("demo_role_entered", { role: v });
  };
  const roleLabel = d?.scope === "market" ? "" : role;
  const cta = () => {
    try {
      localStorage.setItem(DEMO_ANSWERS_KEY, JSON.stringify({
        usCitizen: facts.citizen || undefined, needsSponsorship: facts.sponsorship || undefined,
        securityClearance: facts.clearance === "no" ? "none" : undefined, role, at: Date.now(),
      }));
    } catch { /* storage blocked: sign-up still works, answers just aren't carried */ }
    track("demo_cta_clicked", { answered: !!d?.answered, eligible: d?.eligible ?? null });
    onStart();
  };

  return (
    <Band id="live" inner="px-4 sm:px-10 py-14 sm:py-20">
      <style>{`
        @keyframes pm-flow { 0% { opacity: 0; transform: translateX(40px); } 12% { opacity: 1; transform: none; } 88% { opacity: 1; transform: none; } 100% { opacity: 0; transform: translateX(-40px); } }
        .pm-flow { animation: pm-flow 3.4s ease-in-out both; }
        @media (prefers-reduced-motion: reduce) { .pm-flow { animation: none; } }
      `}</style>
      <SectionLabel>Your market</SectionLabel>
      <h2 className="text-3xl sm:text-5xl font-semibold tracking-[-0.035em] max-w-3xl mb-3">How many jobs can you actually get?</h2>
      <p className="text-lg text-neutral-600 dark:text-neutral-400 max-w-2xl mb-8">
        Tell us what you do. We check every live job's stated requirements and show you what's really open to you, and what's moving right now.
      </p>

      <div className={`border ${RULE} bg-white dark:bg-black`} data-testid="personal-market">
        <div className="px-4 sm:px-6 py-5 space-y-4">
          <form onSubmit={(e) => { e.preventDefault(); pick(roleInput); }} className="flex flex-wrap items-center gap-2">
            <label htmlFor="pm-role" className="sr-only">What do you do?</label>
            <input id="pm-role" value={roleInput} onChange={(e) => setRoleInput(e.target.value)} placeholder="What do you do? e.g. IT support" maxLength={60}
              className={`h-11 flex-1 min-w-[200px] px-4 bg-transparent text-[15px] border ${RULE} outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:focus:border-white`} />
            <button type="submit" className="h-11 px-5 bg-emerald-600 text-white text-[15px] font-medium hover:bg-emerald-500 transition-colors">Show me</button>
          </form>
          <div className="flex flex-wrap gap-2">
            {ROLES.map(r => (
              <button key={r} type="button" onClick={() => pick(r)}
                className={`h-7 px-2.5 border ${RULE} font-geist-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${role === r ? "border-neutral-900 text-neutral-900 dark:border-white dark:text-white" : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"}`}>{r}</button>
            ))}
          </div>
          {role && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-1" data-testid="pm-facts">
              <Toggle id="pm-citizen" label="US citizen?" value={facts.citizen} onChange={v => setFact("citizen", v)} />
              <Toggle id="pm-sponsor" label="Need visa sponsorship?" value={facts.sponsorship} onChange={v => setFact("sponsorship", v)} />
              <Toggle id="pm-clear" label="Active security clearance?" value={facts.clearance} onChange={v => setFact("clearance", v)} />
              <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                Years of experience
                <input type="number" min={0} max={40} inputMode="numeric" value={facts.years} onChange={(e) => setFact("years", e.target.value)}
                  className={`h-8 w-16 px-2 bg-transparent border ${RULE} text-neutral-900 dark:text-white`} />
              </label>
            </div>
          )}
        </div>

        {!role ? null : market.isError ? (
          <p className={`px-4 sm:px-6 py-8 border-t ${RULE} text-sm text-red-600 dark:text-red-400`} role="alert">{(market.error as Error).message}</p>
        ) : !d ? (
          <p className={`px-4 sm:px-6 py-10 border-t ${RULE} font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500`}>Checking every live job…</p>
        ) : (
          <>
            <div className={`px-4 sm:px-6 py-6 border-t ${RULE}`} data-testid="pm-headline">
              {d.answered && d.eligible !== null ? (
                <p className="text-2xl sm:text-3xl font-semibold tracking-tight leading-snug">
                  You can apply to <span className="text-emerald-600 dark:text-emerald-400 tabular-nums">{d.eligible.toLocaleString()}</span> of {d.live.toLocaleString()} live {roleLabel ? `${roleLabel} ` : ""}jobs.
                </p>
              ) : (
                <p className="text-2xl sm:text-3xl font-semibold tracking-tight leading-snug">
                  <span className="tabular-nums">{d.live.toLocaleString()}</span> live {roleLabel ? `${roleLabel} ` : ""}jobs.
                  {d.restrictedShare > 0.04 && <> <span className="text-neutral-500">{oneIn(d.restrictedShare)} require US citizenship or a clearance.</span></>}
                </p>
              )}
              {d.answered ? (
                shutOutChips(d.shutOut).length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3" data-testid="pm-shutout">
                    {shutOutChips(d.shutOut).map(c => <span key={c} className={`border ${RULE} px-2 py-1 text-sm text-neutral-700 dark:text-neutral-300`}>{c}</span>)}
                  </div>
                )
              ) : (
                <p className="text-sm text-neutral-500 mt-2">Answer the questions above to see which of these are open to you.</p>
              )}
              {d.scope === "market" && <p className="text-sm text-neutral-500 mt-2">Not much for "{role}" this week, so this is the whole market.</p>}
            </div>

            <div className={`px-4 sm:px-6 py-4 border-t ${RULE} flex flex-wrap items-center gap-x-4 gap-y-2`}>
              <span className="relative flex w-2 h-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60 animate-ping" />
                <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
              </span>
              <Sparkline values={d.sparkline} />
              <span className="font-geist-mono text-sm tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">▲ {d.openedLast24h.toLocaleString()} opened</span>
                <span className="text-neutral-400"> · </span>
                <span className="text-red-600 dark:text-red-400">▼ {d.closedLast24h.toLocaleString()} closed</span>
                <span className="text-neutral-500"> today</span>
              </span>
              <span className="font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500 sm:ml-auto">
                {d.lastBoardRead ? `boards checked ${ago(d.lastBoardRead)} · next in ${until(d.nextBoardRead)}` : ""}
              </span>
            </div>

            <div className={`px-4 sm:px-6 py-4 border-t ${RULE} min-h-[84px] overflow-hidden`} data-testid="pm-stream">
              {current ? (
                <div key={tick} className="pm-flow flex items-start gap-3">
                  <span className={`mt-0.5 shrink-0 border px-1.5 py-0.5 font-geist-mono text-[10px] uppercase tracking-[0.1em] ${VERDICT_STYLE[current.verdict.label].cls}`}>
                    {VERDICT_STYLE[current.verdict.label].text}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[15px] font-medium truncate">
                      {current.type === "taken_down" ? "▼ " : "▲ "}{current.title}{current.count > 1 ? ` ×${current.count}` : ""}
                      <span className="font-normal text-neutral-500"> · {current.company} · {ago(current.at)}</span>
                    </div>
                    <div className="text-sm text-neutral-600 dark:text-neutral-400 mt-0.5">{current.verdict.reason}</div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-neutral-500">No changes this week for this role.</p>
              )}
            </div>

            <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 sm:px-6 py-4 border-t ${RULE} bg-neutral-50 dark:bg-neutral-950`}>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-md">
                Upload your resume and we'll rank these for you, check each one's requirements, and tell you when a job you applied to closes.
              </p>
              <PrimaryButton onClick={cta}>
                {d.answered && d.eligible ? `See the ${d.eligible.toLocaleString()} you can apply to` : "See your matches"} <ArrowRight className="w-4 h-4" />
              </PrimaryButton>
            </div>
          </>
        )}
      </div>
    </Band>
  );
}
