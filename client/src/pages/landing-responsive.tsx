import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@supabase/auth-helpers-react";
import { ArrowRight, Upload } from "lucide-react";
import {
  SiteShell, Band, SectionLabel, Tag, PrimaryButton, useSiteNav,
} from "@/components/site/site-shell";
import { getUserRole } from "@/lib/auth-role";
import { MarketRadar } from "@/components/site/market-radar";

const RULE = "border-neutral-200 dark:border-neutral-800";

interface LiveStats {
  activeJobs: number;
  companies: number;
  recentlyChecked: number;
  checkWindowHours: number;
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
      <MarketRadar onStart={goToApp} />
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
          Upload your resume once. Get live US roles, ranked by how well you fit, and why.
        </p>
        <div className="mt-9 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
          <PrimaryButton onClick={onStart}>
            <Upload className="w-4 h-4" /> Upload resume. It's free
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

// -- How it works ---------------------------------------------------------------------

function HowItWorks() {
  const steps = [
    { title: "Upload your resume", body: "We read your titles, skills and seniority. No forms to fill in." },
    { title: "Get a ranked feed", body: "Live roles from company career pages, best fit first, each with the reason it matched." },
    { title: "Apply on the company's site", body: "Every match links straight to the real posting on the employer's own site. No reposters in between." },
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
  { title: "Matched on what you've done.", body: "Your titles, skills and seniority, not keyword overlap. A senior backend engineer sees senior backend roles.", tags: ["titles", "skills", "seniority"] },
  { title: "Direct from the company.", body: "Pulled from each employer's own hiring system. No reposters, no aggregator spam.", tags: ["greenhouse", "lever", "ashby"] },
  { title: "Live, and checked.", body: "Every board is re-read every few hours. A job gets the live badge only if we saw it in the last 36 hours.", tags: ["● live · checked"] },
  { title: "Every match explains itself.", body: "A score and the reasons behind it, so an 85 and a 60 look different and you know where to spend your time.", tags: ["score", "why it fits"] },
  { title: "Filters that mean it.", body: "City, remote / hybrid / onsite and date posted run over your whole match set, not just the first page.", tags: ["seattle", "remote", "past 3 days"] },
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
      setMessage("Thanks, you're on the list. We'll email you when employer access opens.");
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
      <p className="text-lg text-neutral-600 dark:text-neutral-400 mb-9">One resume. A ranked feed of live roles. Free.</p>
      <PrimaryButton onClick={onStart}>
        <Upload className="w-4 h-4" /> Upload resume
      </PrimaryButton>
    </Band>
  );
}
