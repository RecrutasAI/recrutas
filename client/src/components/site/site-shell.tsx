import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Menu, X } from "lucide-react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import RecrutasLogo from "@/components/recrutas-logo";
import { ThemeToggleButton } from "@/components/theme-toggle-button";

// Shared chrome for the public marketing pages (home + manifesto): a plain top
// nav, a single content column and a simple footer. Geist for text, Geist Mono
// only for live data, Recrutas green as the one accent.

export type SiteSection = "home" | "manifesto";

const NAV: { label: string; href: string }[] = [
  { label: "How it works", href: "/#how" },
  { label: "Roadmap", href: "/#roadmap" },
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

export function SiteShell({ active, children }: { active: SiteSection; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const go = useSiteNav();
  const nav = (href: string) => { setMenuOpen(false); go(href); };

  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-[#0a0a0a] dark:text-neutral-100 font-geist antialiased">
      <header className="sticky top-0 z-40 border-b border-neutral-200/80 dark:border-neutral-800/80 bg-white/85 dark:bg-[#0a0a0a]/85 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center justify-between">
          <button onClick={() => nav("/")} className="flex items-center gap-2.5" aria-label="Recrutas home">
            <RecrutasLogo size={26} />
            <span className="text-[17px] font-semibold tracking-tight">Recrutas</span>
          </button>
          <nav className="hidden md:flex items-center gap-1">
            {NAV.map((n) => (
              <button
                key={n.label}
                onClick={() => nav(n.href)}
                className={`px-3 py-2 rounded-md text-sm transition-colors ${
                  active === "manifesto" && n.href === "/manifesto"
                    ? "text-neutral-900 dark:text-white"
                    : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white"
                }`}
              >
                {n.label}
              </button>
            ))}
            <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-800 mx-2" />
            <ThemeToggleButton />
            <button
              onClick={() => nav("/auth")}
              className="ml-2 h-9 px-4 rounded-md text-sm font-medium border border-neutral-300 dark:border-neutral-700 hover:border-neutral-900 dark:hover:border-neutral-300 transition-colors"
            >
              Sign in
            </button>
          </nav>
          <button
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="md:hidden p-2 -mr-2"
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
        {menuOpen && (
          <div className="md:hidden border-t border-neutral-200 dark:border-neutral-800 bg-white dark:bg-[#0a0a0a] px-4 pb-4">
            {[...NAV, { label: "Sign in", href: "/auth" }].map((n) => (
              <button
                key={n.label}
                onClick={() => nav(n.href)}
                className="block w-full text-left py-3 border-b border-neutral-100 dark:border-neutral-900 text-[15px]"
              >
                {n.label}
              </button>
            ))}
            <div className="pt-3 flex items-center justify-between">
              <span className="text-sm text-neutral-500">Theme</span>
              <ThemeToggleButton />
            </div>
          </div>
        )}
      </header>

      <main>{children}</main>

      <footer className="border-t border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 flex flex-col sm:flex-row gap-6 sm:items-center justify-between">
          <div className="flex items-center gap-2.5">
            <RecrutasLogo size={20} />
            <span className="text-sm text-neutral-500">© {new Date().getFullYear()} Recrutas · Built for US job seekers</span>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-500">
            <button onClick={() => nav("/manifesto")} className="hover:text-neutral-900 dark:hover:text-white">Manifesto</button>
            <a href="/privacy" className="hover:text-neutral-900 dark:hover:text-white">Privacy</a>
            <a href="/terms" className="hover:text-neutral-900 dark:hover:text-white">Terms</a>
            <a href="https://www.reddit.com/r/recrutas/" target="_blank" rel="noopener noreferrer" className="hover:text-neutral-900 dark:hover:text-white">Community</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

// -- Small building blocks shared by both pages --------------------------------

export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-6xl px-4 sm:px-6 ${className}`}>{children}</div>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400 mb-3">{children}</p>;
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "live" | "next" }) {
  const tones = {
    neutral: "bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400",
    live: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400",
    next: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
  } as const;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function PrimaryButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[15px] font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors shadow-sm"
    >
      {children}
    </button>
  );
}
