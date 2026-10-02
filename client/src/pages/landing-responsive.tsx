import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@supabase/auth-helpers-react";
import { ArrowRight, ArrowUpRight, Upload } from "lucide-react";
import {
  SiteShell, Band, SectionLabel, Tag, PrimaryButton, useSiteNav,
} from "@/components/site/site-shell";
import { getUserRole } from "@/lib/auth-role";

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
      const role = getUserRole(session.user);
      setLocation(role === 'talent_owner' || role === 'recruiter' ? '/talent-dashboard' : '/candidate-dashboard');
    } else {
      // Preserve ?code= param so invite code flows through to signup
      const code = new URLSearchParams(window.location.search).get('code');
      setLocation(code ? `/auth?code=${encodeURIComponent(code)}` : '/auth');
    }
  };

  if (session && !getUserRole(session.user)) {
    setLocation('/role-selection');
    return null;
  }

  return (
    <SiteShell active="home">
      <Hero onStart={goToApp} />
      <LiveSearch onStart={goToApp} />
      <HowItWorks />
      <WhyRecrutas />
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
          onClick={() => go("/#live")}
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

interface LiveRoleSearch {
  total: number;
  thisWeek: number;
  recentlyChecked: number;
  checkWindowHours: number;
  topCompanies: { company: string; count: number }[];
  postings: CheckedJob[];
}

const ROLE_SUGGESTIONS = ["backend engineer", "data scientist", "product manager", "frontend engineer", "data analyst", "designer"];

function PostingRows({ jobs }: { jobs: CheckedJob[] }) {
  return (
    <ul>
      {jobs.map((j, i) => (
        <li key={`${j.company}-${j.title}-${i}`} className={i > 0 ? `border-t ${RULE}` : ""}>
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
  );
}

/**
 * The live card. Empty, it shows roles just re-checked on company boards;
 * with a role typed, it shows that person's live market — no résumé needed.
 */
function LiveSearch({ onStart }: { onStart: () => void }) {
  const [role, setRole] = useState("");
  const [city, setCity] = useState("");
  const [remote, setRemote] = useState(false);
  const [query, setQuery] = useState<{ q: string; location: string; remote: boolean } | null>(null);

  const justChecked = useQuery<{ jobs: CheckedJob[] }>({
    queryKey: ['/api/platform/just-checked'],
    queryFn: async () => {
      const res = await fetch('/api/platform/just-checked');
      if (!res.ok) throw new Error('just-checked unavailable');
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
    retry: false,
  });

  const search = useQuery<LiveRoleSearch>({
    queryKey: ['/api/platform/live-search', query],
    enabled: !!query,
    queryFn: async () => {
      const params = new URLSearchParams({ q: query!.q });
      if (query!.location) params.set('location', query!.location);
      if (query!.remote) params.set('remote', '1');
      const res = await fetch(`/api/platform/live-search?${params}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 429 ? 'Lots of searches in a short time — try again in a minute.' : body.message || 'Search is unavailable right now.');
      return body;
    },
    staleTime: 10 * 60 * 1000,
    retry: false,
  });

  const run = (q = role, location = city, r = remote) => {
    if (q.trim().length < 2) return;
    setQuery({ q: q.trim(), location: location.trim(), remote: r });
  };
  const result = search.data;
  const where = query ? [query.location, query.remote ? "remote" : ""].filter(Boolean).join(" · ") : "";
  const checkedPct = result && result.total > 0 ? Math.round((result.recentlyChecked / result.total) * 100) : 0;

  return (
    <Band id="live" inner="px-4 sm:px-10 py-14 sm:py-20">
      <SectionLabel>Live right now</SectionLabel>
      <h2 className="text-3xl sm:text-5xl font-semibold tracking-[-0.035em] max-w-3xl mb-3">What's live for you right now?</h2>
      <p className="text-lg text-neutral-600 dark:text-neutral-400 max-w-2xl mb-8">Type a role. No résumé, no account — just the real market, today.</p>

      <form
        onSubmit={(e) => { e.preventDefault(); run(); }}
        className={`grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto_auto] border ${RULE}`}
      >
        <label className="sr-only" htmlFor="live-role">Role</label>
        <input
          id="live-role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="Role, e.g. backend engineer"
          maxLength={60}
          className={`h-12 px-4 bg-transparent text-[15px] outline-none placeholder:text-neutral-400 border-b sm:border-b-0 sm:border-r ${RULE}`}
        />
        <label className="sr-only" htmlFor="live-city">City</label>
        <input
          id="live-city"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="City (optional)"
          maxLength={40}
          className={`h-12 px-4 bg-transparent text-[15px] outline-none placeholder:text-neutral-400 border-b sm:border-b-0 sm:border-r ${RULE}`}
        />
        <button
          type="button"
          aria-pressed={remote}
          onClick={() => setRemote(!remote)}
          className={`h-12 px-4 font-geist-mono text-[11px] uppercase tracking-[0.14em] border-b sm:border-b-0 sm:border-r ${RULE} transition-colors ${
            remote ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400" : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
          }`}
        >
          {remote ? "✓ " : ""}Remote only
        </button>
        <button type="submit" className="h-12 px-6 bg-emerald-600 text-white text-[15px] font-medium hover:bg-emerald-500 transition-colors">
          Show me
        </button>
      </form>
      <div className="flex flex-wrap gap-2 mt-3">
        {ROLE_SUGGESTIONS.map((sug) => (
          <button
            key={sug}
            onClick={() => { setRole(sug); run(sug); }}
            className={`px-2.5 h-7 border ${RULE} font-geist-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500 hover:text-neutral-900 dark:hover:text-white hover:border-neutral-900 dark:hover:border-white transition-colors`}
          >
            {sug}
          </button>
        ))}
      </div>

      <div className={`mt-8 border ${RULE} bg-white dark:bg-black`}>
        {!query ? (
          <>
            <div className={`flex items-center justify-between gap-4 px-4 sm:px-5 h-11 border-b ${RULE} bg-neutral-50 dark:bg-neutral-950`}>
              <div className="flex items-center gap-2 font-geist-mono text-[11px] uppercase tracking-[0.14em]">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                Just checked on company boards
              </div>
              <span className="hidden sm:block font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">Real postings · every 15 min</span>
            </div>
            {(justChecked.data?.jobs.length ?? 0) > 0
              ? <PostingRows jobs={justChecked.data!.jobs} />
              : <p className="px-5 py-6 text-sm text-neutral-500">Type a role above to see what's live.</p>}
          </>
        ) : search.isLoading ? (
          <p className="px-5 py-10 font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">Reading the market…</p>
        ) : search.isError ? (
          <p className="px-5 py-8 text-sm text-red-600 dark:text-red-400" role="alert">{(search.error as Error).message}</p>
        ) : result && result.total === 0 ? (
          <div className="px-5 py-8">
            <p className="text-[15px]">No live <span className="font-medium">"{query.q}"</span> roles{where ? ` (${where})` : ""} right now.</p>
            <p className="text-sm text-neutral-500 mt-1">Try a broader title, or drop the city.</p>
          </div>
        ) : result ? (
          <>
            <div className={`px-4 sm:px-5 py-4 border-b ${RULE} bg-neutral-50 dark:bg-neutral-950`}>
              <div className="font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500 mb-3">
                "{query.q}"{where ? ` · ${where}` : ""}
              </div>
              <dl className="grid grid-cols-3 gap-4">
                {[
                  [result.total.toLocaleString(), "live roles"],
                  [result.thisWeek.toLocaleString(), "new this week"],
                  [`${checkedPct}%`, `checked < ${result.checkWindowHours}h`],
                ].map(([v, l]) => (
                  <div key={l}>
                    <dd className="font-geist-mono text-2xl sm:text-3xl tracking-tight">{v}</dd>
                    <dt className="font-geist-mono text-[10px] sm:text-[11px] uppercase tracking-[0.14em] text-neutral-500 mt-1">{l}</dt>
                  </div>
                ))}
              </dl>
              {result.topCompanies.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 mt-4">
                  <span className="font-geist-mono text-[10px] uppercase tracking-[0.14em] text-neutral-500 mr-1">Hiring most</span>
                  {result.topCompanies.map((c) => <Tag key={c.company}>{c.company} · {c.count}</Tag>)}
                </div>
              )}
            </div>
            {result.postings.length > 0 && <PostingRows jobs={result.postings} />}
            <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 sm:px-5 py-4 border-t ${RULE}`}>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                That's {result.total.toLocaleString()} live {result.total === 1 ? "role" : "roles"}. Let us rank them against your résumé.
              </p>
              <PrimaryButton onClick={onStart}>
                Rank these for me <ArrowRight className="w-4 h-4" />
              </PrimaryButton>
            </div>
          </>
        ) : null}
      </div>
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
