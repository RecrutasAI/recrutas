import React, { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Linkedin, Menu, MessageSquare, X } from "lucide-react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import RecrutasLogo from "@/components/recrutas-logo";
import { ThemeToggleButton } from "@/components/theme-toggle-button";
import { FeedbackDialog } from "@/components/FeedbackButton";

// Shared chrome for the public marketing pages (home + manifesto). The look is
// precise and flat — a framed column with hairline rules, square corners, mono
// labels — with Recrutas green as the one accent. Geist for text, Geist Mono
// for labels and live data.

export type SiteSection = "home" | "manifesto" | "docs" | "legal";

const NAV: { label: string; href: string }[] = [
  { label: "How it works", href: "/#how" },
  { label: "Manifesto", href: "/manifesto" },
  { label: "Docs", href: "/docs" },
];

export function useSiteNav(): (href: string) => void {
  const [, setLocation] = useLocation();
  return (href: string) => {
    if (href.startsWith("/#")) {
      const id = href.slice(2);
      if (window.location.pathname === "/") {
        document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
        return;
      }
      setLocation("/");
      // Wait for the home page to mount before scrolling to the anchor.
      setTimeout(() => document.getElementById(id)?.scrollIntoView(), 50);
      return;
    }
    setLocation(href);
    window.scrollTo(0, 0);
  };
}

const RULE = "border-neutral-200 dark:border-neutral-800";

// The X and Reddit marks aren't in lucide, so they're drawn inline.
function XLogo({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function RedditLogo({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm6.67 13.34c.03.2.04.4.04.61 0 3.07-3.57 5.56-7.98 5.56S2.75 17.02 2.75 13.95c0-.21.01-.41.04-.61a1.6 1.6 0 0 1 .65-3.06c.43 0 .82.17 1.11.45 1.1-.79 2.61-1.3 4.29-1.37l.8-3.78a.34.34 0 0 1 .41-.26l2.66.57a1.14 1.14 0 1 1-.12.56l-2.38-.5-.72 3.4c1.65.07 3.13.58 4.21 1.36a1.6 1.6 0 1 1 1.95 2.63zM8.3 12.9a1.14 1.14 0 1 0 0 2.28 1.14 1.14 0 0 0 0-2.28zm6.24 3.49a.28.28 0 0 0-.39 0c-.54.53-1.39.79-2.15.79s-1.61-.26-2.15-.79a.28.28 0 0 0-.39.39c.67.66 1.68.96 2.54.96s1.87-.3 2.54-.96a.28.28 0 0 0 0-.39zm-.66-3.49a1.14 1.14 0 1 0 0 2.28 1.14 1.14 0 0 0 0-2.28z" />
    </svg>
  );
}

const SOCIALS: { label: string; href: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { label: "Recrutas on LinkedIn", href: "https://www.linkedin.com/company/recrutas/", icon: Linkedin },
  { label: "Recrutas on X", href: "https://x.com/recrutasai", icon: XLogo },
  { label: "Recrutas community on Reddit", href: "https://www.reddit.com/r/recrutas/", icon: RedditLogo },
];

export function SiteShell({ active, children }: { active: SiteSection; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const go = useSiteNav();
  const nav = (href: string) => { setMenuOpen(false); go(href); };

  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-black dark:text-neutral-100 font-geist antialiased">
      <header className={`sticky top-0 z-40 border-b ${RULE} bg-white/85 dark:bg-black/85 backdrop-blur`}>
        <div className={`mx-auto max-w-6xl h-14 flex items-stretch justify-between lg:border-x ${RULE}`}>
          <button onClick={() => nav("/")} className="flex items-center gap-2.5 px-4 sm:px-6" aria-label="Recrutas home">
            <RecrutasLogo size={24} />
            <span className="text-[16px] font-semibold tracking-tight">Recrutas</span>
          </button>
          <nav className="hidden md:flex items-stretch">
            {NAV.map((n) => (
              <button
                key={n.label}
                onClick={() => nav(n.href)}
                className={`px-5 border-l ${RULE} font-geist-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
                  (active === "manifesto" && n.href === "/manifesto") || (active === "docs" && n.href === "/docs")
                    ? "text-neutral-900 dark:text-white"
                    : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                }`}
              >
                {n.label}
              </button>
            ))}
            <div className={`flex items-center px-3 border-l ${RULE}`}>
              <ThemeToggleButton />
            </div>
            <button
              onClick={() => nav("/auth")}
              className="px-6 font-geist-mono text-[11px] uppercase tracking-[0.14em] bg-neutral-900 text-white dark:bg-white dark:text-black hover:bg-emerald-600 dark:hover:bg-emerald-400 transition-colors"
            >
              Sign in
            </button>
          </nav>
          <button
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="md:hidden px-4"
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
        {menuOpen && (
          <div className={`md:hidden border-t ${RULE} bg-white dark:bg-black`}>
            {[...NAV, { label: "Sign in", href: "/auth" }].map((n) => (
              <button
                key={n.label}
                onClick={() => nav(n.href)}
                className={`block w-full text-left px-4 py-4 border-b ${RULE} font-geist-mono text-xs uppercase tracking-[0.14em]`}
              >
                {n.label}
              </button>
            ))}
            <div className="px-4 py-3 flex items-center justify-between">
              <span className="font-geist-mono text-xs uppercase tracking-[0.14em] text-neutral-500">Theme</span>
              <ThemeToggleButton />
            </div>
          </div>
        )}
      </header>

      <main>{children}</main>

      <footer className={`border-t ${RULE}`}>
        {/* Feedback lives here on the public pages — the floating button
            covered page content. */}
        <div className={`mx-auto max-w-6xl lg:border-x ${RULE} px-4 sm:px-6 py-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b ${RULE}`}>
          <div>
            <div className="font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500 mb-1">Feedback</div>
            <div className="text-[15px]">Something off, or an idea? We read every message.</div>
          </div>
          <button
            onClick={() => setFeedbackOpen(true)}
            className={`shrink-0 inline-flex items-center justify-center gap-2 h-10 px-4 border ${RULE} font-geist-mono text-[11px] uppercase tracking-[0.14em] hover:border-neutral-900 dark:hover:border-white transition-colors`}
          >
            <MessageSquare className="w-3.5 h-3.5" /> Send feedback
          </button>
        </div>
        <div className={`mx-auto max-w-6xl px-4 sm:px-6 py-8 lg:border-x ${RULE} flex flex-col md:flex-row gap-6 md:items-center justify-between`}>
          <div className="flex items-center gap-2.5 font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
            <RecrutasLogo size={18} />
            © {new Date().getFullYear()} Recrutas · Built for US job seekers
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <div className="flex flex-wrap gap-x-3 gap-y-2 font-geist-mono text-xs text-neutral-500">
              <button onClick={() => nav("/manifesto")} className="hover:text-neutral-900 dark:hover:text-white">Manifesto</button>
              <span aria-hidden>/</span>
              <button onClick={() => nav("/docs")} className="hover:text-neutral-900 dark:hover:text-white">Docs</button>
              <span aria-hidden>/</span>
              <a href="/privacy" className="hover:text-neutral-900 dark:hover:text-white">Privacy</a>
              <span aria-hidden>/</span>
              <a href="/terms" className="hover:text-neutral-900 dark:hover:text-white">Terms</a>
              <span aria-hidden>/</span>
              <button onClick={() => setFeedbackOpen(true)} className="hover:text-neutral-900 dark:hover:text-white">Feedback</button>
            </div>
            <div className="flex items-center">
              {SOCIALS.map(({ label, href, icon: Icon }) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  title={label}
                  className={`flex items-center justify-center w-9 h-9 border ${RULE} -ml-px first:ml-0 text-neutral-500 hover:text-neutral-900 dark:hover:text-white hover:border-neutral-900 dark:hover:border-white hover:z-10 transition-colors`}
                >
                  <Icon className="w-4 h-4" />
                </a>
              ))}
            </div>
          </div>
        </div>
      </footer>
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </div>
  );
}

// -- Small building blocks shared by both pages --------------------------------

/** A full-width band with a hairline on top; its content sits in the framed column. */
export function Band({ children, id, className = "", inner = "" }: {
  children: ReactNode; id?: string; className?: string; inner?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-14 border-t ${RULE} ${className}`}>
      <div className={`mx-auto max-w-6xl lg:border-x ${RULE} ${inner}`}>{children}</div>
    </section>
  );
}

/** Mono section label with a trailing rule: "01 · HOW IT WORKS ————". */
export function SectionLabel({ n, children }: { n?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 mb-8">
      <span className="font-geist-mono text-[11px] uppercase tracking-[0.16em] text-neutral-500 shrink-0">
        {n && <span className="text-emerald-600 dark:text-emerald-400">{n} · </span>}
        {children}
      </span>
      <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
    </div>
  );
}

export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "live" }) {
  const tones = {
    neutral: "border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400",
    live: "border-emerald-600/40 text-emerald-700 dark:border-emerald-400/40 dark:text-emerald-400",
  } as const;
  return (
    <span className={`inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-geist-mono text-[10px] uppercase tracking-wider ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function PrimaryButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center justify-center gap-2 h-11 px-5 text-[15px] font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
    >
      {children}
    </button>
  );
}

/**
 * Wrapper for long-form policy pages (privacy, terms). Sections inside are
 * plain <section><h2/><p/><ul/></section>; typography comes from here.
 */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <SiteShell active="legal">
      <Band className="border-t-0" inner="px-4 sm:px-10 pt-16 pb-20 sm:pt-24 sm:pb-28">
        <article className="mx-auto max-w-2xl">
          <SectionLabel>Legal</SectionLabel>
          <h1 className="text-4xl sm:text-5xl font-semibold tracking-[-0.04em] leading-[1.05] mb-4">{title}</h1>
          <p className="font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500 mb-12">Last updated: {updated}</p>
          <div
            className={[
              "space-y-10 text-[15px] sm:text-base leading-[1.75] text-neutral-700 dark:text-neutral-300",
              "[&_section]:border-t [&_section]:border-neutral-200 dark:[&_section]:border-neutral-800 [&_section]:pt-8",
              "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-neutral-900 dark:[&_h2]:text-white [&_h2]:mb-3",
              "[&_p]:mb-3 [&_ul]:space-y-2 [&_ul]:pl-5 [&_ul]:list-disc [&_li]:marker:text-emerald-600",
              "[&_a]:text-emerald-600 dark:[&_a]:text-emerald-400 [&_a]:underline [&_a]:underline-offset-2",
            ].join(" ")}
          >
            {children}
          </div>
        </article>
      </Band>
    </SiteShell>
  );
}
