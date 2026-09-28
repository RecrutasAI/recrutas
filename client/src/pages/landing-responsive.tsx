import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@supabase/auth-helpers-react";
import { ArrowRight, ArrowUpRight, Upload, FileText, ListOrdered, MousePointerClick } from "lucide-react";
import {
  SiteShell, Container, Eyebrow, Pill, PrimaryButton, useSiteNav,
} from "@/components/site/site-shell";

const FIREFOX_LISTING = "https://addons.mozilla.org/en-US/firefox/addon/recrutas-auto-fill/";

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
      <ApplyAnywhere />
      <Hiring onHire={() => setLocation('/signup/talent-owner')} />
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
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 w-[900px] h-[500px] rounded-full bg-emerald-500/10 dark:bg-emerald-500/[0.07] blur-3xl"
      />
      <Container className="relative pt-16 pb-12 sm:pt-24 sm:pb-16">
        <button
          onClick={() => go("/#how")}
          className="inline-flex items-center gap-2 mb-7 rounded-full border border-neutral-200 dark:border-neutral-800 bg-white/60 dark:bg-neutral-900/60 px-3 py-1 text-sm"
        >
          <span className="relative flex w-2 h-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60 animate-ping" />
            <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
          </span>
          Now open for US job seekers
          <ArrowRight className="w-3.5 h-3.5 text-neutral-400" />
        </button>
        <h1 className="text-[2.6rem] leading-[1.05] sm:text-6xl lg:text-7xl font-semibold tracking-[-0.04em] max-w-4xl">
          Job Search,{" "}
          <span className="whitespace-nowrap text-emerald-600 dark:text-emerald-400">Re-Invented.</span>
        </h1>
        <p className="mt-6 text-lg sm:text-xl leading-relaxed text-neutral-600 dark:text-neutral-400 max-w-2xl">
          <span className="text-neutral-900 dark:text-white font-medium">Live US jobs, ranked for you.</span>{" "}
          Upload your résumé once. Recrutas ranks live roles from company career pages by how well you
          actually fit — and tells you why. No searching, no ghost listings.
        </p>
        <div className="mt-9 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
          <PrimaryButton onClick={onStart}>
            <Upload className="w-4 h-4" /> Upload résumé — it's free
          </PrimaryButton>
          <span className="text-sm text-neutral-500">Free for candidates · US roles only for now</span>
        </div>
        {stats && stats.activeJobs > 0 && (
          <dl className="mt-12 grid grid-cols-3 max-w-2xl divide-x divide-neutral-200 dark:divide-neutral-800">
            {[
              [stats.activeJobs.toLocaleString(), "live roles"],
              [stats.companies.toLocaleString(), "companies"],
              // Only quote the check rate when it is a number worth quoting.
              checkedPct >= 50
                ? [`${checkedPct}%`, `checked in the last ${stats.checkWindowHours}h`]
                : ["4h", "between board re-reads"],
            ].map(([value, label], i) => (
              <div key={label} className={i === 0 ? "pr-4" : "px-4"}>
                <dt className="sr-only">{label}</dt>
                <dd className="font-geist-mono text-xl sm:text-2xl tracking-tight">{value}</dd>
                <dd className="text-xs sm:text-sm text-neutral-500 mt-0.5">{label}</dd>
              </div>
            ))}
          </dl>
        )}
      </Container>
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
    <section>
      <Container className="pb-16 sm:pb-24">
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between gap-4 px-4 sm:px-5 py-3 border-b border-neutral-200 dark:border-neutral-800">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              Just checked on company boards
            </div>
            <span className="hidden sm:block text-xs text-neutral-500">Real postings · refreshed every 15 minutes</span>
          </div>
          <ul>
            {jobs.map((j, i) => (
              <li key={`${j.company}-${j.title}`} className={i > 0 ? "border-t border-neutral-100 dark:border-neutral-900" : ""}>
                <a
                  href={j.externalUrl ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group grid grid-cols-[1fr_auto] sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_90px] items-center gap-x-4 gap-y-0.5 px-4 sm:px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900/60 transition-colors"
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
        <p className="mt-3 text-sm text-neutral-500">
          A sample of what's in the feed. Yours is ranked against your résumé.
        </p>
      </Container>
    </section>
  );
}

// -- How it works ---------------------------------------------------------------------

function HowItWorks() {
  const steps = [
    { icon: FileText, title: "Upload your résumé", body: "We read your titles, skills and seniority — no forms to fill in." },
    { icon: ListOrdered, title: "Get a ranked feed", body: "Live roles from company career pages, best fit first — each with the reason it matched." },
    { icon: MousePointerClick, title: "Apply on the company's site", body: "Straight to the real posting. The Auto-Fill extension can complete the form for you." },
  ];
  return (
    <section id="how" className="scroll-mt-20 border-t border-neutral-200 dark:border-neutral-800">
      <Container className="py-16 sm:py-24">
        <Eyebrow>How it works</Eyebrow>
        <h2 className="text-3xl sm:text-4xl font-semibold tracking-[-0.03em] max-w-2xl mb-12">
          You stop searching. You start choosing.
        </h2>
        <ol className="grid md:grid-cols-3 gap-4">
          {steps.map((s, i) => (
            <li key={s.title} className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-6">
              <div className="flex items-center justify-between mb-8">
                <s.icon className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                <span className="font-geist-mono text-sm text-neutral-400">0{i + 1}</span>
              </div>
              <h3 className="text-lg font-semibold tracking-tight mb-2">{s.title}</h3>
              <p className="text-neutral-600 dark:text-neutral-400 leading-relaxed">{s.body}</p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}

// -- Why Recrutas ------------------------------------------------------------------------

const REASONS: { title: string; body: string }[] = [
  { title: "Matched on what you've done", body: "Your titles, skills and seniority — not keyword overlap. A senior backend engineer sees senior backend roles." },
  { title: "Direct from the company", body: "Pulled from each employer's own hiring system — Greenhouse, Lever, Ashby and more. No reposters, no aggregator spam." },
  { title: "Live, and checked", body: "Every board is re-read every few hours. A job gets the live badge only if we saw it in the last 36 hours." },
  { title: "Every match explains itself", body: "A score and the reasons behind it, so an 85 and a 60 look different and you know where to spend your time." },
  { title: "Filters that mean it", body: "City, remote / hybrid / onsite and date posted run over your whole match set — not just the first page." },
  { title: "Free for candidates", body: "No subscription, no premium tier for job seekers. Companies will pay; people looking for work don't." },
];

function WhyRecrutas() {
  return (
    <section className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
      <Container className="py-16 sm:py-24">
        <Eyebrow>Why Recrutas</Eyebrow>
        <h2 className="text-3xl sm:text-4xl font-semibold tracking-[-0.03em] max-w-2xl mb-12">
          Real jobs, made to fit you. No ghosts, no leftovers.
        </h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-10 gap-y-10">
          {REASONS.map((r) => (
            <div key={r.title} className="border-l-2 border-emerald-500/70 pl-5">
              <h3 className="font-semibold tracking-tight mb-2">{r.title}</h3>
              <p className="text-neutral-600 dark:text-neutral-400 leading-relaxed">{r.body}</p>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}

// -- Anatomy of a match -----------------------------------------------------------------------

const ANATOMY: { id: string; label: string; body: string }[] = [
  { id: "score", label: "Match score", body: "How closely the role fits you — what your experience means next to the posting, the skills you share, your titles and seniority." },
  { id: "why", label: "Why it fits", body: "The specific overlap: the skills you share with the posting and how your experience lines up." },
  { id: "live", label: "Live badge", body: "Shown only when the job was on the company's board in the last 36 hours. When a company takes a posting down, we close it too." },
  { id: "link", label: "Direct link", body: "Apply goes to the posting on the company's own site — never a reposter or an aggregator." },
];

function Marker({ n, active }: { n: number; active: boolean }) {
  return (
    <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-semibold shrink-0 transition-colors ${
      active ? "bg-emerald-600 text-white" : "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
    }`}>{n}</span>
  );
}

function MatchAnatomy() {
  const [active, setActive] = useState(ANATOMY[0].id);
  const isOn = (id: string) => active === id;
  const ring = (id: string) => (isOn(id) ? "ring-2 ring-emerald-500/60 rounded-md" : "");

  return (
    <section className="border-t border-neutral-200 dark:border-neutral-800">
      <Container className="py-16 sm:py-24 grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <Eyebrow>Anatomy of a match</Eyebrow>
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-[-0.03em] mb-8">Every card tells you four things.</h2>
          <ul className="space-y-2">
            {ANATOMY.map((a, i) => (
              <li key={a.id}>
                <button
                  onClick={() => setActive(a.id)}
                  onMouseEnter={() => setActive(a.id)}
                  className={`w-full text-left flex gap-3 rounded-lg p-3 transition-colors ${isOn(a.id) ? "bg-neutral-100 dark:bg-neutral-900" : ""}`}
                >
                  <Marker n={i + 1} active={isOn(a.id)} />
                  <span>
                    <span className="block font-medium">{a.label}</span>
                    {isOn(a.id) && <span className="block mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{a.body}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl bg-neutral-100 dark:bg-neutral-900 p-5 sm:p-10">
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0a0a0a] p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <div className="text-base font-semibold">Senior Backend Engineer</div>
                <div className="text-sm text-neutral-500">Example Co · Remote (US)</div>
              </div>
              <span className={`flex items-center gap-2 p-1 ${ring("score")}`}>
                <Marker n={1} active={isOn("score")} />
                <span className="font-geist-mono text-sm font-medium rounded-md bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 px-2 py-0.5">87%</span>
              </span>
            </div>
            <div className={`flex gap-2 text-sm text-neutral-600 dark:text-neutral-400 mb-5 p-1 ${ring("why")}`}>
              <Marker n={2} active={isOn("why")} />
              <span><span className="text-neutral-900 dark:text-white font-medium">Why it fits:</span> Go, PostgreSQL, Kubernetes · 6 years backend · senior title match</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className={`flex items-center gap-2 p-1 ${ring("live")}`}>
                <Marker n={3} active={isOn("live")} />
                <Pill tone="live">● Live · checked 3h ago</Pill>
              </span>
              <span className={`flex items-center gap-2 p-1 ${ring("link")}`}>
                <Marker n={4} active={isOn("link")} />
                <span className="inline-flex items-center gap-1 text-sm font-medium">Apply on company site <ArrowUpRight className="w-4 h-4" /></span>
              </span>
            </div>
          </div>
          <p className="mt-3 text-xs text-neutral-500 text-center">Example card — your feed uses your résumé.</p>
        </div>
      </Container>
    </section>
  );
}

// -- Extension + developers -------------------------------------------------------------------------

function ApplyAnywhere() {
  return (
    <section className="border-t border-neutral-200 dark:border-neutral-800">
      <Container className="py-16 sm:py-24 grid md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-6 sm:p-8">
          <div className="flex gap-2 mb-6"><Pill tone="live">Firefox · live</Pill><Pill>Chrome · soon</Pill></div>
          <h3 className="text-xl font-semibold tracking-tight mb-2">Auto-Fill extension</h3>
          <p className="text-neutral-600 dark:text-neutral-400 leading-relaxed mb-6">
            Open any application on the company's own site and fill the whole form from your Recrutas profile in one click.
          </p>
          <a href={FIREFOX_LISTING} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400 hover:underline">
            Add to Firefox <ArrowUpRight className="w-4 h-4" />
          </a>
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-6 sm:p-8">
          <div className="flex gap-2 mb-6"><Pill>Exploring</Pill></div>
          <h3 className="text-xl font-semibold tracking-tight mb-2">For developers: Recrutas in your AI tools</h3>
          <p className="text-neutral-600 dark:text-neutral-400 leading-relaxed mb-6">
            Ask Claude, Cursor or ChatGPT: <span className="text-neutral-900 dark:text-white">"find live backend roles that fit my résumé, and tell me why."</span> We're exploring an MCP server.
          </p>
          <a href="mailto:support@recrutas.ai?subject=MCP%20early%20access" className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400 hover:underline">
            Request early access <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </Container>
    </section>
  );
}

// -- Hiring (early employers) -----------------------------------------------------------------------

function Hiring({ onHire }: { onHire: () => void }) {
  return (
    <section className="border-t border-neutral-200 dark:border-neutral-800">
      <Container className="py-12 sm:py-16">
        <div className="rounded-xl bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-5">
          <div>
            <div className="text-lg font-semibold tracking-tight">Hiring? We're onboarding a few early employers.</div>
            <div className="text-neutral-500 mt-1">Exam-ranked candidates, direct chat with the people you want, no agency fees.</div>
          </div>
          <button
            onClick={onHire}
            className="shrink-0 inline-flex items-center gap-2 h-10 px-4 rounded-lg text-sm font-medium border border-neutral-300 dark:border-neutral-700 hover:border-neutral-900 dark:hover:border-neutral-300 transition-colors"
          >
            Sign up as an employer <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </Container>
    </section>
  );
}

// -- Manifesto band + final CTA ---------------------------------------------------------------------------

function ManifestoBand() {
  const go = useSiteNav();
  return (
    <section className="bg-neutral-950 text-white dark:bg-emerald-950/30 dark:border-y dark:border-emerald-900/40">
      <Container className="py-20 sm:py-28">
        <p className="text-sm font-medium text-emerald-400 mb-6">Our manifesto</p>
        <blockquote className="text-3xl sm:text-5xl font-semibold tracking-[-0.03em] leading-[1.1] max-w-4xl">
          No one should have to beg for the right to earn a living.
        </blockquote>
        <p className="mt-6 text-lg text-neutral-400 max-w-2xl leading-relaxed">
          Too many good people are sending hundreds of applications into the dark and hearing nothing back.
          No reply. No reason. Just silence. We do not accept this.
        </p>
        <button onClick={() => go("/manifesto")} className="mt-8 inline-flex items-center gap-1.5 font-medium text-emerald-400 hover:underline">
          Read the manifesto <ArrowRight className="w-4 h-4" />
        </button>
      </Container>
    </section>
  );
}

function FinalCta({ onStart }: { onStart: () => void }) {
  return (
    <section>
      <Container className="py-20 sm:py-28 text-center">
        <h2 className="text-3xl sm:text-5xl font-semibold tracking-[-0.03em] mb-4">See what you're a fit for.</h2>
        <p className="text-lg text-neutral-600 dark:text-neutral-400 mb-9">One résumé. A ranked feed of live roles. Free.</p>
        <PrimaryButton onClick={onStart}>
          <Upload className="w-4 h-4" /> Upload résumé
        </PrimaryButton>
      </Container>
    </section>
  );
}
