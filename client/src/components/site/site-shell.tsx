import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Menu, X } from "lucide-react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import RecrutasLogo from "@/components/recrutas-logo";
import { ThemeToggleButton } from "@/components/theme-toggle-button";

// Shared chrome for the public marketing pages (home + manifesto). The look is
// precise and flat — a framed column with hairline rules, square corners, mono
// labels — with Recrutas green as the one accent. Geist for text, Geist Mono
// for labels and live data.

export type SiteSection = "home" | "manifesto";

const NAV: { label: string; href: string }[] = [
  { label: "How it works", href: "/#how" },
  { label: "Manifesto", href: "/manifesto" },
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

export function SiteShell({ active, children }: { active: SiteSection; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
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
                  active === "manifesto" && n.href === "/manifesto"
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
        <div className={`mx-auto max-w-6xl px-4 sm:px-6 py-8 lg:border-x ${RULE} flex flex-col sm:flex-row gap-5 sm:items-center justify-between`}>
          <div className="flex items-center gap-2.5 font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
            <RecrutasLogo size={18} />
            © {new Date().getFullYear()} Recrutas · Built for US job seekers
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-2 font-geist-mono text-xs text-neutral-500">
            <button onClick={() => nav("/manifesto")} className="hover:text-neutral-900 dark:hover:text-white">Manifesto</button>
            <span aria-hidden>/</span>
            <a href="/privacy" className="hover:text-neutral-900 dark:hover:text-white">Privacy</a>
            <span aria-hidden>/</span>
            <a href="/terms" className="hover:text-neutral-900 dark:hover:text-white">Terms</a>
            <span aria-hidden>/</span>
            <a href="https://www.reddit.com/r/recrutas/" target="_blank" rel="noopener noreferrer" className="hover:text-neutral-900 dark:hover:text-white">Community</a>
          </div>
        </div>
      </footer>
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

export function OutlineButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 h-10 px-4 border ${RULE} font-geist-mono text-[11px] uppercase tracking-[0.14em] hover:border-neutral-900 dark:hover:border-white transition-colors`}
    >
      {children}
    </button>
  );
}
