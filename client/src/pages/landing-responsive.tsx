import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@supabase/auth-helpers-react";
import { ArrowRight, ArrowUpRight, Upload } from "lucide-react";
import {
  SiteShell, SectionLabel, MonoTag, PrimaryButton, SecondaryButton,
} from "@/components/site/site-shell";

const FIREFOX_LISTING = "https://addons.mozilla.org/en-US/firefox/addon/recrutas-auto-fill/";

// Companies with live roles in the feed (checked against prod 2026-09-28).
// Plain text, not logos — we list where the jobs come from, not endorsements.
const ROLES_FROM = [
  "Anthropic", "OpenAI", "Stripe", "Databricks", "Datadog", "Anduril",
  "Waymo", "Figma", "Ramp", "Notion", "Coinbase", "Airbnb",
];

interface LiveStats {
  activeJobs: number;
  companies: number;
  recentlyChecked: number;
  checkWindowHours: number;
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
    <SiteShell active="readme" left={<Pitch onStart={goToApp} onSignIn={() => setLocation('/auth')} />}>
      <Readme onStart={goToApp} />
      <Features />
      <MatchAnatomy />
      <Roadmap onHire={() => setLocation('/signup/talent-owner')} />
      <ManifestoTeaser onRead={() => { setLocation('/manifesto'); window.scrollTo(0, 0); }} />
      <FinalCta onStart={goToApp} />
    </SiteShell>
  );
}

// -- Left panel ---------------------------------------------------------------

function Pitch({ onStart, onSignIn }: { onStart: () => void; onSignIn: () => void }) {
  return (
    <div className="max-w-md">
      <a
        href="/#roadmap"
        onClick={(e) => { e.preventDefault(); document.getElementById('roadmap')?.scrollIntoView({ behavior: 'smooth' }); }}
        className="inline-flex items-center gap-2 mb-6 rounded-full bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-3 py-1 text-xs sm:text-sm"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        <span>Now open</span>
        <span className="text-neutral-400">|</span>
        <span className="font-medium">Candidate dashboard · US roles</span>
        <ArrowRight className="w-3.5 h-3.5" />
      </a>
      <h1 className="text-[2.1rem] sm:text-[2.6rem] leading-[1.1] tracking-[-0.03em] font-normal mb-5">
        Live US jobs,<br />ranked for you.
      </h1>
      <p className="text-neutral-600 dark:text-neutral-400 text-[15px] leading-relaxed mb-8">
        Upload your résumé once. Recrutas ranks live roles from company career pages by how well you
        actually fit — and tells you why.
      </p>
      <div className="flex flex-wrap gap-3 mb-6">
        <PrimaryButton onClick={onStart}>
          <Upload className="w-4 h-4" /> Upload résumé — free
        </PrimaryButton>
        <SecondaryButton onClick={onSignIn}>Sign in</SecondaryButton>
      </div>
      <p className="font-geist-mono text-[11px] tracking-wider text-neutral-500">
        FREE FOR CANDIDATES · NO CARD · US ONLY FOR NOW
      </p>
    </div>
  );
}

// -- README -------------------------------------------------------------------

type ReadmeTab = "feed" | "extension" | "mcp";

function Readme({ onStart }: { onStart: () => void }) {
  const [tab, setTab] = useState<ReadmeTab>("feed");
  const { data: stats } = useQuery<LiveStats>({
    queryKey: ['/api/platform/live-stats'],
    queryFn: async () => {
      const res = await fetch('/api/platform/live-stats');
      if (!res.ok) throw new Error('live stats unavailable');
      return res.json();
    },
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const checkedPct = stats && stats.activeJobs > 0
    ? Math.round((stats.recentlyChecked / stats.activeJobs) * 100)
    : 0;

  return (
    <section>
      <SectionLabel>README</SectionLabel>
      <p className="text-[15px] sm:text-base leading-relaxed text-neutral-600 dark:text-neutral-400 mb-8">
        Job boards make you do the searching. Recrutas reads your résumé and ranks{" "}
        <strong className="font-medium text-neutral-900 dark:text-white">live jobs pulled straight from company career pages</strong>{" "}
        by how well you fit — your titles, your skills, your seniority. Every match{" "}
        <strong className="font-medium text-neutral-900 dark:text-white">explains itself</strong>, every listing is{" "}
        <strong className="font-medium text-neutral-900 dark:text-white">checked against the company's own board</strong>.
        You stop searching and start choosing.
      </p>

      <div className="border border-neutral-200 dark:border-neutral-800">
        <div className="flex border-b border-neutral-200 dark:border-neutral-800 px-4 gap-6">
          {([
            ["feed", "Feed"],
            ["extension", "Extension"],
            ["mcp", "MCP"],
          ] as [ReadmeTab, string][]).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`py-3 text-sm transition-colors ${
                tab === id
                  ? "text-neutral-900 dark:text-white shadow-[inset_0_-1px_0_currentColor]"
                  : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="px-4 py-4 font-geist-mono text-[13px] leading-7 min-h-[132px]">
          {tab === "feed" && (
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
              <ol>
                <li><span className="text-neutral-400">01</span>  upload <span className="text-emerald-600 dark:text-emerald-400">resume.pdf</span></li>
                <li><span className="text-neutral-400">02</span>  we parse your titles, skills and seniority</li>
                <li><span className="text-neutral-400">03</span>  your feed: live roles, ranked by fit, with the reason</li>
                <li><span className="text-neutral-400">04</span>  filter by city, remote / hybrid / onsite, date posted</li>
              </ol>
              <button onClick={onStart} className="shrink-0 inline-flex items-center gap-1 text-xs tracking-wider hover:underline">
                START <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {tab === "extension" && (
            <div className="space-y-1">
              <p className="text-neutral-600 dark:text-neutral-400 font-geist text-sm mb-2">
                The Recrutas Auto-Fill extension fills the application form on the company's own site — one click.
              </p>
              <p className="flex items-center gap-3">
                <MonoTag tone="live">live</MonoTag> Firefox
                <a href={FIREFOX_LISTING} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs hover:underline">
                  INSTALL <ArrowUpRight className="w-3.5 h-3.5" />
                </a>
              </p>
              <p className="flex items-center gap-3"><MonoTag tone="next">soon</MonoTag> Chrome</p>
            </div>
          )}
          {tab === "mcp" && (
            <div className="space-y-2">
              <p className="text-neutral-600 dark:text-neutral-400 font-geist text-sm">
                Ask Claude, Cursor or ChatGPT for your matches — <span className="text-neutral-900 dark:text-white">"find live backend roles that fit my
                résumé, and tell me why."</span> We're exploring an MCP server for developers.
              </p>
              <p className="flex items-center gap-3">
                <MonoTag>exploring</MonoTag>
                <a href="mailto:support@recrutas.ai?subject=MCP%20early%20access" className="inline-flex items-center gap-1 text-xs hover:underline">
                  REQUEST EARLY ACCESS <ArrowUpRight className="w-3.5 h-3.5" />
                </a>
              </p>
            </div>
          )}
        </div>
      </div>

      {stats && stats.activeJobs > 0 && (
        <div className="grid grid-cols-3 border-x border-b border-neutral-200 dark:border-neutral-800">
          {[
            [stats.activeJobs.toLocaleString(), "live roles"],
            [stats.companies.toLocaleString(), "companies"],
            // Only quote the check rate when it is a number worth quoting.
            ...(checkedPct >= 50
              ? [[`${checkedPct}%`, `checked < ${stats.checkWindowHours}h`]]
              : [["every 4h", "boards re-read"]]),
          ].map(([value, label], i) => (
            <div key={label} className={`px-4 py-3 ${i < 2 ? "border-r border-neutral-200 dark:border-neutral-800" : ""}`}>
              <div className="text-lg sm:text-xl tracking-tight">{value}</div>
              <div className="font-geist-mono text-[10px] sm:text-[11px] tracking-wider uppercase text-neutral-500">{label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-8">
        <div className="flex items-center gap-4 mb-4">
          <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
          <span className="font-geist-mono text-[11px] tracking-[0.14em] text-neutral-500">LIVE ROLES FROM</span>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-neutral-400 dark:text-neutral-500 text-[15px] font-medium tracking-tight">
          {ROLES_FROM.map((c) => <span key={c}>{c}</span>)}
          {stats && stats.companies > ROLES_FROM.length && (
            <span className="font-geist-mono text-xs self-center">+ {(stats.companies - ROLES_FROM.length).toLocaleString()} more</span>
          )}
        </div>
      </div>
    </section>
  );
}

// -- Features -----------------------------------------------------------------

const FEATURES: { title: string; body: string; chips: string[] }[] = [
  {
    title: "Matched on what you've done.",
    body: "Your titles, skills and seniority — not keyword overlap. A senior backend engineer sees senior backend roles.",
    chips: ["titles", "skills", "seniority"],
  },
  {
    title: "Direct from the company.",
    body: "Pulled from the employer's own applicant tracking system. No reposters, no aggregator spam.",
    chips: ["greenhouse", "lever", "ashby", "smartrecruiters"],
  },
  {
    title: "Live, and checked.",
    body: "Every board is re-read every few hours. A job gets the live badge only if we saw it in the last 36 hours.",
    chips: ["● live · checked"],
  },
  {
    title: "Knows why it fits.",
    body: "Each match shows its score and the reasons behind it, so an 85 and a 60 look different.",
    chips: ["score", "why it fits"],
  },
  {
    title: "Filters that mean it.",
    body: "City, remote / hybrid / onsite and date posted run over your whole match set — not just the first page.",
    chips: ["seattle", "remote", "past 3 days"],
  },
  {
    title: "Apply in one click.",
    body: "The Auto-Fill extension completes the application on the company's own site.",
    chips: ["firefox ✓", "chrome soon"],
  },
];

function Features() {
  return (
    <section>
      <SectionLabel>Features</SectionLabel>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 border-t border-l border-neutral-200 dark:border-neutral-800">
        {FEATURES.map((f, i) => (
          <div key={f.title} className="p-5 border-r border-b border-neutral-200 dark:border-neutral-800">
            <div className="font-geist-mono text-[11px] text-neutral-400 mb-2">{String(i + 1).padStart(2, "0")}</div>
            <h3 className="text-sm font-medium mb-1.5">{f.title}</h3>
            <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400 mb-4">{f.body}</p>
            <div className="flex flex-wrap gap-1.5">
              {f.chips.map((c) => <MonoTag key={c} tone={c.startsWith("●") ? "live" : "neutral"}>{c}</MonoTag>)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// -- Anatomy of a match ---------------------------------------------------------

const ANATOMY: { id: string; label: string; body: string }[] = [
  { id: "score", label: "MATCH SCORE", body: "How closely the role fits you — what your experience means next to the posting, the skills you share, your titles and seniority." },
  { id: "why", label: "WHY IT FITS", body: "The specific overlap: the skills you share with the posting and how your experience lines up." },
  { id: "live", label: "LIVE BADGE", body: "Shown only when the job was on the company's board in the last 36 hours. When a company takes a posting down, we close it too." },
  { id: "link", label: "DIRECT LINK", body: "Apply goes to the posting on the company's own site — never a reposter or an aggregator." },
];

function MatchAnatomy() {
  const [active, setActive] = useState(ANATOMY[0].id);
  const current = ANATOMY.find((a) => a.id === active)!;
  const hl = (id: string) =>
    active === id ? "ring-1 ring-neutral-900 dark:ring-white ring-offset-2 ring-offset-white dark:ring-offset-black" : "";

  return (
    <section>
      <SectionLabel>Anatomy of a match</SectionLabel>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 -mt-2 mb-6">What every card in your feed tells you.</p>
      <div className="grid lg:grid-cols-[1fr_200px] border border-neutral-200 dark:border-neutral-800">
        <div className="p-5 sm:p-8 bg-neutral-50 dark:bg-neutral-950">
          <div className="font-geist-mono text-[11px] text-neutral-400 mb-3">example card</div>
          <div className="border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black p-4 sm:p-5">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <div className="text-[15px] font-medium">Senior Backend Engineer</div>
                <div className="text-sm text-neutral-500">Example Co · Remote (US)</div>
              </div>
              <span className={`shrink-0 font-geist-mono text-sm px-2 py-0.5 border border-emerald-600/40 text-emerald-700 dark:text-emerald-400 ${hl("score")}`}>
                87%
              </span>
            </div>
            <div className={`text-sm text-neutral-600 dark:text-neutral-400 mb-4 p-1 -m-1 ${hl("why")}`}>
              <span className="text-neutral-900 dark:text-white">Why it fits:</span> Go, PostgreSQL, Kubernetes · 6 years backend · senior title match
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className={hl("live")}><MonoTag tone="live">● live · checked 3h ago</MonoTag></span>
              <span className={`inline-flex items-center gap-1 text-xs font-geist-mono ${hl("link")}`}>
                APPLY ON COMPANY SITE <ArrowUpRight className="w-3.5 h-3.5" />
              </span>
            </div>
          </div>
        </div>
        <div className="border-t lg:border-t-0 lg:border-l border-neutral-200 dark:border-neutral-800 flex flex-col">
          {ANATOMY.map((a) => (
            <button
              key={a.id}
              onClick={() => setActive(a.id)}
              onMouseEnter={() => setActive(a.id)}
              className={`text-left px-4 py-3 font-geist-mono text-[11px] tracking-wider border-b border-neutral-200 dark:border-neutral-800 transition-colors ${
                active === a.id ? "text-neutral-900 dark:text-white bg-neutral-100 dark:bg-neutral-900" : "text-neutral-500"
              }`}
            >
              {a.label}
            </button>
          ))}
          <p className="p-4 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{current.body}</p>
        </div>
      </div>
    </section>
  );
}

// -- Roadmap --------------------------------------------------------------------

const PHASES: { n: string; title: string; status: string; tone: "live" | "next" | "neutral"; body: string }[] = [
  {
    n: "01", title: "Candidate dashboard", status: "live", tone: "live",
    body: "The ranked feed, résumé parsing, filters, saved and applied jobs. Everything above is this phase.",
  },
  {
    n: "02", title: "Employer job board", status: "next", tone: "next",
    body: "Companies post roles on Recrutas. You take a short exam built from the job itself; pass it and you get a real answer within 24 hours and a direct line to the hiring manager.",
  },
  {
    n: "03", title: "Browser extension", status: "firefox live · chrome soon", tone: "neutral",
    body: "One-click auto-fill on the company's own application form, on every major browser.",
  },
  {
    n: "04", title: "Mobile", status: "later", tone: "neutral",
    body: "Your feed and your applications, in your pocket.",
  },
];

function Roadmap({ onHire }: { onHire: () => void }) {
  return (
    <section>
      <SectionLabel id="roadmap">Roadmap</SectionLabel>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 -mt-2 mb-6">
        Built in order. Each phase ships when the one before it works for real people.
      </p>
      <div className="border-t border-neutral-200 dark:border-neutral-800">
        {PHASES.map((p) => (
          <div key={p.n} className="grid grid-cols-[40px_1fr] sm:grid-cols-[56px_220px_1fr] gap-x-4 gap-y-2 py-5 border-b border-neutral-200 dark:border-neutral-800">
            <div className="font-geist-mono text-[11px] text-neutral-400 pt-0.5">{p.n}</div>
            <div>
              <div className="text-sm font-medium mb-1.5">{p.title}</div>
              <MonoTag tone={p.tone}>{p.status}</MonoTag>
            </div>
            <p className="col-start-2 sm:col-start-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{p.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border border-neutral-200 dark:border-neutral-800 p-5">
        <div>
          <div className="text-sm font-medium">Hiring? Phase 2 is taking early employers.</div>
          <div className="text-sm text-neutral-500">Exam-ranked candidates, direct chat, no agency fees.</div>
        </div>
        <button
          onClick={onHire}
          className="shrink-0 inline-flex items-center gap-2 h-9 px-4 font-geist-mono text-[11px] tracking-wider border border-neutral-300 dark:border-neutral-700 hover:border-neutral-900 dark:hover:border-white transition-colors"
        >
          POST A JOB — EARLY ACCESS <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </section>
  );
}

// -- Manifesto teaser + final CTA --------------------------------------------------

function ManifestoTeaser({ onRead }: { onRead: () => void }) {
  return (
    <section>
      <SectionLabel>Manifesto</SectionLabel>
      <blockquote className="text-2xl sm:text-3xl tracking-[-0.02em] leading-snug mb-4">
        No one should have to beg for the right to earn a living.
      </blockquote>
      <p className="text-sm sm:text-[15px] leading-relaxed text-neutral-600 dark:text-neutral-400 max-w-2xl mb-5">
        Too many good people are sending hundreds of applications into the dark and hearing nothing
        back. No reply. No reason. Just silence. We do not accept this.
      </p>
      <button onClick={onRead} className="inline-flex items-center gap-1.5 font-geist-mono text-xs tracking-wider hover:underline">
        READ THE MANIFESTO <ArrowRight className="w-3.5 h-3.5" />
      </button>
    </section>
  );
}

function FinalCta({ onStart }: { onStart: () => void }) {
  return (
    <section className="border border-neutral-200 dark:border-neutral-800 p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-5">
      <div>
        <div className="text-lg tracking-tight">Stop searching. Start choosing.</div>
        <div className="text-sm text-neutral-500">One résumé, a ranked feed of live roles. Free for candidates.</div>
      </div>
      <PrimaryButton onClick={onStart}>
        <Upload className="w-4 h-4" /> Upload résumé
      </PrimaryButton>
    </section>
  );
}
