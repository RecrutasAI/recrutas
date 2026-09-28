import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@supabase/auth-helpers-react";
import { ArrowRight, ArrowUpRight, Upload } from "lucide-react";
import {
  SiteShell, Band, SectionLabel, Tag, PrimaryButton, useSiteNav,
} from "@/components/site/site-shell";

const RULE = "border-neutral-200 dark:border-neutral-800";

interface LiveStats {
  activeJobs: number;
  companies: number;
  recentlyChecked: number;
  checkWindowHours: number;
}

interface CheckedJob {
  title: string;
  company: string;
  location: string | null;
  workType: string | null;
  externalUrl: string | null;
  lastLivenessCheck: string | null;
}

function useLiveStats() {
  return useQuery<LiveStats>({
    queryKey: ['/api/platform/live-stats'],
    queryFn: async () => {
      const res = await fetch('/api/platform/live-stats');
      if (!res.ok) throw new Error('live stats unavailable');
      return res.json();
    },
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
}

export default function LandingResponsive() {
  const session = useSession();
  const [, setLocation] = useLocation();

  const goToApp = () => {
    if (session) {
      const role = (session.user as any)?.user_metadata?.role;
      setLocation(role === 'talent_owner' || role === 'recruiter' ? '/talent-dashboard' : '/candidate-dashboard');
    } else {
      // Preserve ?code= param so invite code flows through to signup
      const code = new URLSearchParams(window.location.search).get('code');
      setLocation(code ? `/auth?code=${encodeURIComponent(code)}` : '/auth');
    }
  };

  if (session && !session.user?.user_metadata?.role) {
    setLocation('/role-selection');
    return null;
  }

  return (
    <SiteShell active="home">
      <Hero onStart={goToApp} />
      <JustChecked />
      <HowItWorks />
      <WhyRecrutas />
      <MatchAnatomy />
      <EmployerInterest />
      <ManifestoBand />
      <FinalCta onStart={goToApp} />
    </SiteShell>
  );
}

// -- Hero -----------------------------------------------------------------------

function Hero({ onStart }: { onStart: () => void }) {
  const { data: stats } = useLiveStats();
  const go = useSiteNav();
  const checkedPct = stats && stats.activeJobs > 0
    ? Math.round((stats.recentlyChecked / stats.activeJobs) * 100)
    : 0;

  return (
    <section className="relative overflow-hidden">
      {/* Faint square grid, fading out from the top — the page's ledger paper. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 text-neutral-900/[0.05] dark:text-white/[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          maskImage: "radial-gradient(ellipse 80% 70% at 30% 0%, black 20%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(ellipse 80% 70% at 30% 0%, black 20%, transparent 75%)",
        }}
      />
      <div aria-hidden className="pointer-events-none absolute -top-48 left-1/4 w-[700px] h-[420px] rounded-full bg-emerald-500/10 dark:bg-emerald-500/[0.08] blur-3xl" />
      <div className={`relative mx-auto max-w-6xl lg:border-x ${RULE} px-4 sm:px-10 pt-16 pb-14 sm:pt-24 sm:pb-20`}>
        <button
          onClick={() => go("/#how")}
          className={`inline-flex items-center gap-2 mb-8 border ${RULE} bg-white/70 dark:bg-black/70 px-3 py-1.5 font-geist-mono text-[11px] uppercase tracking-[0.14em]`}
        >
          <span className="relative flex w-2 h-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60 animate-ping" />
            <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
          </span>
          Now open for US job seekers
          <ArrowRight className="w-3.5 h-3.5 text-neutral-400" />
        </button>
        <h1 className="text-[2.6rem] leading-[1.05] sm:text-6xl lg:text-7xl font-semibold tracking-[-0.04em] max-w-4xl">
          Real jobs.{" "}
          <span className="whitespace-nowrap text-emerald-600 dark:text-emerald-400">Made to fit you.</span>
        </h1>
        <p className="mt-6 text-lg sm:text-xl leading-relaxed text-neutral-600 dark:text-neutral-400 max-w-2xl">
          Upload your résumé once. Get live US roles, ranked by how well you fit — and why.
        </p>
        <div className="mt-9 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
          <PrimaryButton onClick={onStart}>
            <Upload className="w-4 h-4" /> Upload résumé — it's free
          </PrimaryButton>
          <span className="font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">Free for candidates · US roles only</span>
        </div>
      </div>
      {stats && stats.activeJobs > 0 && (
        <div className={`relative border-t ${RULE}`}>
          <dl className={`mx-auto max-w-6xl lg:border-x ${RULE} grid grid-cols-3 divide-x divide-neutral-200 dark:divide-neutral-800`}>
            {[
              [stats.activeJobs.toLocaleString(), "live roles"],
              [stats.companies.toLocaleString(), "companies"],
              // Only quote the check rate when it is a number worth quoting.
              checkedPct >= 50
                ? [`${checkedPct}%`, `checked < ${stats.checkWindowHours}h`]
                : ["4h", "between board re-reads"],
            ].map(([value, label]) => (
              <div key={label} className="px-4 sm:px-10 py-5">
                <dt className="sr-only">{label}</dt>
                <dd className="font-geist-mono text-xl sm:text-3xl tracking-tight">{value}</dd>
                <dd className="font-geist-mono text-[10px] sm:text-[11px] uppercase tracking-[0.14em] text-neutral-500 mt-1">{label}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}

// -- Signature: roles just re-checked on company boards ------------------------------

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

// Long multi-city strings ("San Francisco, CA | New York City, NY | …") are
// trimmed to the first place plus a count.
function shortLocation(loc: string | null, workType: string | null): string {
  if (!loc || !loc.trim()) return workType === "remote" ? "Remote" : "United States";
  const parts = loc.split(/\s*[|;•]\s*/).filter(Boolean);
  return parts.length > 1 ? `${parts[0].trim()} +${parts.length - 1}` : loc.trim();
}

function JustChecked() {
  const { data } = useQuery<{ jobs: CheckedJob[] }>({
    queryKey: ['/api/platform/just-checked'],
    queryFn: async () => {
      const res = await fetch('/api/platform/just-checked');
      if (!res.ok) throw new Error('just-checked unavailable');
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  const jobs = data?.jobs ?? [];
  if (jobs.length === 0) return null;

  return (
    <Band inner="px-4 sm:px-10 py-14 sm:py-20">
      <div className={`border ${RULE} bg-white dark:bg-black`}>
        <div className={`flex items-center justify-between gap-4 px-4 sm:px-5 h-11 border-b ${RULE} bg-neutral-50 dark:bg-neutral-950`}>
          <div className="flex items-center gap-2 font-geist-mono text-[11px] uppercase tracking-[0.14em]">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            Just checked on company boards
          </div>
          <span className="hidden sm:block font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">Real postings · every 15 min</span>
        </div>
        <ul>
          {jobs.map((j, i) => (
            <li key={`${j.company}-${j.title}`} className={i > 0 ? `border-t ${RULE}` : ""}>
              <a
                href={j.externalUrl ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="group grid grid-cols-[1fr_auto] sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_90px] items-center gap-x-4 gap-y-0.5 px-4 sm:px-5 py-3 hover:bg-emerald-50/60 dark:hover:bg-emerald-500/[0.06] transition-colors"
              >
                <span className="text-[15px] font-medium truncate">{j.title}</span>
                <span className="sm:hidden font-geist-mono text-xs text-emerald-600 dark:text-emerald-400 text-right">{timeAgo(j.lastLivenessCheck)}</span>
                <span className="text-sm text-neutral-600 dark:text-neutral-400 truncate">{j.company}</span>
                <span className="hidden sm:block text-sm text-neutral-500 truncate">{shortLocation(j.location, j.workType)}</span>
                <span className="hidden sm:flex items-center justify-end gap-1.5 font-geist-mono text-xs text-emerald-600 dark:text-emerald-400">
                  {timeAgo(j.lastLivenessCheck)}
                  <ArrowUpRight className="w-3.5 h-3.5 text-neutral-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-3 font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
        A sample of the feed. Yours is ranked against your résumé.
      </p>
    </Band>
  );
}

// -- How it works ---------------------------------------------------------------------

function HowItWorks() {
  const steps = [
    { title: "Upload your résumé", body: "We read your titles, skills and seniority — no forms to fill in." },
    { title: "Get a ranked feed", body: "Live roles from company career pages, best fit first — each with the reason it matched." },
    { title: "Apply on the company's site", body: "Every match links straight to the real posting on the employer's own site — no reposters in between." },
  ];
  return (
    <Band id="how" inner="px-4 sm:px-10 py-14 sm:py-20">
      <SectionLabel n="01">How it works</SectionLabel>
      <h2 className="text-3xl sm:text-5xl font-semibold tracking-[-0.035em] max-w-3xl mb-12">
        You stop searching. You start choosing.
      </h2>
      <ol className={`grid md:grid-cols-3 border-t border-l ${RULE}`}>
        {steps.map((s, i) => (
          <li key={s.title} className={`p-6 sm:p-7 border-r border-b ${RULE}`}>
            <div className="font-geist-mono text-[11px] text-emerald-600 dark:text-emerald-400 mb-10">STEP 0{i + 1}</div>
            <h3 className="text-lg font-semibold tracking-tight mb-2">{s.title}</h3>
            <p className="text-neutral-600 dark:text-neutral-400 leading-relaxed">{s.body}</p>
          </li>
        ))}
      </ol>
    </Band>
  );
}

// -- Why Recrutas ------------------------------------------------------------------------

const REASONS: { title: string; body: string; tags: string[] }[] = [
  { title: "Matched on what you've done.", body: "Your titles, skills and seniority — not keyword overlap. A senior backend engineer sees senior backend roles.", tags: ["titles", "skills", "seniority"] },
  { title: "Direct from the company.", body: "Pulled from each employer's own hiring system. No reposters, no aggregator spam.", tags: ["greenhouse", "lever", "ashby"] },
  { title: "Live, and checked.", body: "Every board is re-read every few hours. A job gets the live badge only if we saw it in the last 36 hours.", tags: ["● live · checked"] },
  { title: "Every match explains itself.", body: "A score and the reasons behind it, so an 85 and a 60 look different and you know where to spend your time.", tags: ["score", "why it fits"] },
  { title: "Filters that mean it.", body: "City, remote / hybrid / onsite and date posted run over your whole match set — not just the first page.", tags: ["seattle", "remote", "past 3 days"] },
  { title: "Free for candidates.", body: "No subscription, no premium tier for job seekers. Companies will pay; people looking for work don't.", tags: ["$0"] },
];

function WhyRecrutas() {
  return (
    <Band inner="px-4 sm:px-10 py-14 sm:py-20">
      <SectionLabel n="02">Why Recrutas</SectionLabel>
      <h2 className="text-3xl sm:text-5xl font-semibold tracking-[-0.035em] max-w-3xl mb-12">
        Real jobs, made to fit you. No ghosts, no leftovers.
      </h2>
      <div className={`grid sm:grid-cols-2 lg:grid-cols-3 border-t border-l ${RULE}`}>
        {REASONS.map((r, i) => (
          <div key={r.title} className={`p-6 sm:p-7 border-r border-b ${RULE} hover:bg-neutral-50 dark:hover:bg-neutral-950 transition-colors`}>
            <div className="font-geist-mono text-[11px] text-neutral-400 mb-4">{String(i + 1).padStart(2, "0")}</div>
            <h3 className="font-semibold tracking-tight mb-2">{r.title}</h3>
            <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400 mb-5">{r.body}</p>
            <div className="flex flex-wrap gap-1.5">
              {r.tags.map((t) => <Tag key={t} tone={t.startsWith("●") ? "live" : "neutral"}>{t}</Tag>)}
            </div>
          </div>
        ))}
      </div>
    </Band>
  );
}

// -- A real match: the production scorer on a sample résumé ------------------------------------------

interface SampleMatch {
  persona: { id: string; label: string; summary: string };
  title: string;
  company: string;
  location: string | null;
  workType: string | null;
  externalUrl: string | null;
  lastLivenessCheck: string | null;
  matchScore: number;
  skillMatches: string[];
  partialSkillMatches: string[];
  aiExplanation: string;
}

const PERSONAS: { id: string; label: string }[] = [
  { id: "backend", label: "Backend engineer" },
  { id: "data", label: "Data scientist" },
  { id: "frontend", label: "Frontend engineer" },
];

const ANATOMY: { id: string; label: string; body: string }[] = [
  { id: "score", label: "Match score", body: "How closely the role fits the résumé — titles, shared skills and seniority, weighed by the same engine that ranks your feed." },
  { id: "why", label: "Why it fits", body: "The specific overlap: the skills the résumé shares with the posting, and the engine's own explanation of the match." },
  { id: "live", label: "Live badge", body: "Shown only when the job was on the company's board in the last 36 hours. When a company takes a posting down, we close it too." },
  { id: "link", label: "Direct link", body: "Apply goes to the posting on the company's own site — never a reposter or an aggregator." },
];

function Marker({ n, active }: { n: number; active: boolean }) {
  return (
    <span className={`inline-flex items-center justify-center w-5 h-5 font-geist-mono text-[10px] font-semibold shrink-0 transition-colors ${
      active ? "bg-emerald-600 text-white" : "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
    }`}>{n}</span>
  );
}

function MatchAnatomy() {
  const [active, setActive] = useState(ANATOMY[0].id);
  const [persona, setPersona] = useState(PERSONAS[0].id);
  const { data, isLoading } = useQuery<{ match: SampleMatch | null }>({
    queryKey: ['/api/platform/sample-match', persona],
    queryFn: async () => {
      const res = await fetch(`/api/platform/sample-match?persona=${persona}`);
      if (!res.ok) throw new Error('sample match unavailable');
      return res.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: false,
    placeholderData: (previous) => previous,
  });
  const match = data?.match ?? null;
  const isOn = (id: string) => active === id;
  const ring = (id: string) => (isOn(id) ? "outline outline-1 outline-offset-2 outline-emerald-500" : "");
  const skills = match ? [...match.skillMatches, ...match.partialSkillMatches] : [];

  return (
    <Band inner="px-4 sm:px-10 py-14 sm:py-20">
      <SectionLabel n="03">A real match</SectionLabel>
      <div className={`grid lg:grid-cols-[1fr_1.1fr] border ${RULE}`}>
        <div className={`lg:border-r ${RULE}`}>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-[-0.03em] p-6 sm:p-8 pb-4 sm:pb-6">Every card tells you four things.</h2>
          <ul>
            {ANATOMY.map((a, i) => (
              <li key={a.id} className={`border-t ${RULE}`}>
                <button
                  onClick={() => setActive(a.id)}
                  onMouseEnter={() => setActive(a.id)}
                  className={`w-full text-left flex gap-3 px-6 sm:px-8 py-4 transition-colors ${isOn(a.id) ? "bg-neutral-50 dark:bg-neutral-950" : ""}`}
                >
                  <Marker n={i + 1} active={isOn(a.id)} />
                  <span>
                    <span className="block font-geist-mono text-[11px] uppercase tracking-[0.14em] pt-0.5">{a.label}</span>
                    {isOn(a.id) && <span className="block mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{a.body}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className={`order-first lg:order-none flex flex-col p-5 sm:p-8 bg-neutral-50 dark:bg-neutral-950 border-b lg:border-b-0 ${RULE}`}>
          <div className="font-geist-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500 mb-2">Try a sample résumé</div>
          <div className={`flex flex-wrap border-t border-l ${RULE} mb-3`} role="tablist">
            {PERSONAS.map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={persona === p.id}
                onClick={() => setPersona(p.id)}
                className={`flex-1 min-w-[110px] px-3 h-9 border-r border-b ${RULE} font-geist-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                  persona === p.id ? "bg-neutral-900 text-white dark:bg-white dark:text-black" : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {match && (
            <p className="text-xs text-neutral-500 mb-4">
              <span className="font-geist-mono uppercase tracking-[0.12em] text-[10px]">Résumé:</span> {match.persona.summary}
            </p>
          )}

          {match ? (
            <div className={`border ${RULE} bg-white dark:bg-black p-5 ${isLoading ? "opacity-60" : ""} transition-opacity`}>
              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="min-w-0">
                  <div className="text-base font-semibold">{match.title}</div>
                  <div className="text-sm text-neutral-500 truncate">{match.company} · {shortLocation(match.location, match.workType)}</div>
                </div>
                <span className={`flex items-center gap-2 shrink-0 ${ring("score")}`}>
                  <Marker n={1} active={isOn("score")} />
                  <span className="font-geist-mono text-sm font-medium border border-emerald-600/40 text-emerald-700 dark:text-emerald-400 px-2 py-0.5">{match.matchScore}%</span>
                </span>
              </div>
              <div className={`flex gap-2 text-sm text-neutral-600 dark:text-neutral-400 mb-5 ${ring("why")}`}>
                <Marker n={2} active={isOn("why")} />
                <div className="min-w-0">
                  {skills.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {skills.map((sk) => <Tag key={sk}>{sk}</Tag>)}
                    </div>
                  )}
                  <span>{match.aiExplanation}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className={`flex items-center gap-2 ${ring("live")}`}>
                  <Marker n={3} active={isOn("live")} />
                  <Tag tone="live">● Live · checked {timeAgo(match.lastLivenessCheck)}</Tag>
                </span>
                <a
                  href={match.externalUrl ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex items-center gap-2 hover:underline ${ring("link")}`}
                >
                  <Marker n={4} active={isOn("link")} />
                  <span className="inline-flex items-center gap-1 text-sm font-medium">Apply on company site <ArrowUpRight className="w-4 h-4" /></span>
                </a>
              </div>
            </div>
          ) : (
            <div className={`border ${RULE} bg-white dark:bg-black p-5 text-sm text-neutral-500`}>
              {isLoading ? "Scoring live jobs…" : "No live match right now — try another résumé."}
            </div>
          )}
          <p className="mt-3 font-geist-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500">
            A real live job, scored by the real engine for this sample résumé. Your feed uses yours.
          </p>
        </div>
      </div>
    </Band>
  );
}

// -- Employers: interest list only (phase 2 isn't open) -----------------------------------------------

function EmployerInterest() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes("@")) {
      setState("error");
      setMessage("Enter a work email.");
      return;
    }
    setState("sending");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, source: "employer" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Something went wrong. Try again in a minute.");
      setState("done");
      setMessage("Thanks — you're on the list. We'll email you when employer access opens.");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Something went wrong. Try again in a minute.");
    }
  };

  return (
    <Band inner="px-4 sm:px-10 py-10 sm:py-12">
      <div className="grid md:grid-cols-[1fr_minmax(0,420px)] gap-6 md:items-center">
        <div>
          <div className="font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500 mb-2">For employers</div>
          <div className="text-lg font-semibold tracking-tight">Hiring? Join the employer interest list.</div>
          <div className="text-neutral-500 mt-1">Employer access isn't open yet. Leave your work email and we'll reach out when it is.</div>
        </div>
        {state === "done" ? (
          <p className="font-geist-mono text-[12px] text-emerald-600 dark:text-emerald-400" role="status">{message}</p>
        ) : (
          <form onSubmit={submit} className="w-full">
            <div className={`flex border ${RULE} focus-within:border-neutral-900 dark:focus-within:border-white transition-colors`}>
              <label htmlFor="employer-email" className="sr-only">Work email</label>
              <input
                id="employer-email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); if (state === "error") setState("idle"); }}
                className="flex-1 min-w-0 h-10 px-3 bg-transparent text-sm outline-none placeholder:text-neutral-400"
              />
              <button
                type="submit"
                disabled={state === "sending"}
                className="shrink-0 h-10 px-4 font-geist-mono text-[11px] uppercase tracking-[0.14em] bg-neutral-900 text-white dark:bg-white dark:text-black hover:bg-emerald-600 dark:hover:bg-emerald-400 disabled:opacity-60 transition-colors"
              >
                {state === "sending" ? "Sending…" : "Notify me"}
              </button>
            </div>
            {state === "error" && <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">{message}</p>}
          </form>
        )}
      </div>
    </Band>
  );
}

// -- Manifesto band + final CTA ---------------------------------------------------------------------------

function ManifestoBand() {
  const go = useSiteNav();
  return (
    <Band
      className="bg-neutral-950 text-white dark:bg-emerald-950/30"
      inner="border-neutral-800 dark:border-emerald-900/40 px-4 sm:px-10 py-20 sm:py-28"
    >
      <p className="font-geist-mono text-[11px] uppercase tracking-[0.16em] text-emerald-400 mb-6">Our manifesto</p>
      <blockquote className="text-3xl sm:text-5xl font-semibold tracking-[-0.03em] leading-[1.1] max-w-4xl">
        No one should have to beg for the right to earn a living.
      </blockquote>
      <p className="mt-6 text-lg text-neutral-400 max-w-2xl leading-relaxed">
        Too many good people are sending hundreds of applications into the dark and hearing nothing back.
        No reply. No reason. Just silence. We do not accept this.
      </p>
      <button onClick={() => go("/manifesto")} className="mt-8 inline-flex items-center gap-1.5 font-geist-mono text-[11px] uppercase tracking-[0.14em] text-emerald-400 hover:underline">
        Read the manifesto <ArrowRight className="w-3.5 h-3.5" />
      </button>
    </Band>
  );
}

function FinalCta({ onStart }: { onStart: () => void }) {
  return (
    <Band inner="px-4 sm:px-10 py-20 sm:py-28 text-center">
      <h2 className="text-3xl sm:text-5xl font-semibold tracking-[-0.035em] mb-4">See what you're a fit for.</h2>
      <p className="text-lg text-neutral-600 dark:text-neutral-400 mb-9">One résumé. A ranked feed of live roles. Free.</p>
      <PrimaryButton onClick={onStart}>
        <Upload className="w-4 h-4" /> Upload résumé
      </PrimaryButton>
    </Band>
  );
}
