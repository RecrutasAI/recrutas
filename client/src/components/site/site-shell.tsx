import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { ArrowUpRight, Menu, X } from "lucide-react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import RecrutasLogo from "@/components/recrutas-logo";
import { ThemeToggleButton } from "@/components/theme-toggle-button";

// Shared chrome for the public marketing pages (home + manifesto): a sticky
// left panel carrying the pitch, and a right column with tab-style navigation.
// Styling is deliberately flat — hairline borders, square corners, mono labels.

export type SiteTab = "readme" | "manifesto" | "roadmap";

const TABS: { id: SiteTab; label: string; href: string }[] = [
  { id: "readme", label: "README", href: "/" },
  { id: "manifesto", label: "MANIFESTO", href: "/manifesto" },
  { id: "roadmap", label: "ROADMAP", href: "/#roadmap" },
];

const FOOTER_LINKS: { label: string; href: string; external?: boolean }[] = [
  { label: "Manifesto", href: "/manifesto" },
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
  { label: "Community", href: "https://www.reddit.com/r/recrutas/", external: true },
];

interface SiteShellProps {
  active: SiteTab;
  /** Pitch shown in the sticky left panel on desktop, and as the hero on mobile. */
  left: ReactNode;
  children: ReactNode;
}

export function SiteShell({ active, left, children }: SiteShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [, setLocation] = useLocation();

  const go = (href: string) => {
    setMenuOpen(false);
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

  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-black dark:text-neutral-100 font-geist antialiased">
      {/* Mobile top bar */}
      <header className="lg:hidden sticky top-0 z-40 flex items-center justify-between h-14 px-4 border-b border-neutral-200 dark:border-neutral-800 bg-white/90 dark:bg-black/90 backdrop-blur">
        <Wordmark onClick={() => go("/")} />
        <button
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          className="p-2 -mr-2"
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </header>
      {menuOpen && (
        <div className="lg:hidden fixed inset-x-0 top-14 bottom-0 z-40 bg-white dark:bg-black border-t border-neutral-200 dark:border-neutral-800 flex flex-col">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => go(t.href)}
              className="text-left px-4 py-4 border-b border-neutral-200 dark:border-neutral-800 font-geist-mono text-sm tracking-wider"
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={() => go("/auth")}
            className="text-left px-4 py-4 border-b border-neutral-200 dark:border-neutral-800 font-geist-mono text-sm tracking-wider"
          >
            SIGN-IN
          </button>
          <div className="px-4 py-4 flex items-center justify-between">
            <span className="font-geist-mono text-xs tracking-wider text-neutral-500">THEME</span>
            <ThemeToggleButton />
          </div>
        </div>
      )}

      <div className="lg:flex">
        {/* Left panel */}
        <aside className="relative lg:sticky lg:top-0 lg:h-screen lg:w-[40%] lg:shrink-0 lg:border-r border-neutral-200 dark:border-neutral-800 overflow-hidden">
          <LinesBackdrop />
          <div className="relative h-full flex flex-col px-4 sm:px-7">
            <div className="hidden lg:flex h-14 items-center">
              <Wordmark onClick={() => go("/")} />
            </div>
            <div className="flex-1 flex flex-col justify-center py-14 lg:py-0">{left}</div>
            <div className="hidden lg:flex h-16 items-center justify-between">
              <FooterLinks />
              <ThemeToggleButton />
            </div>
          </div>
        </aside>

        {/* Right column */}
        <div className="flex-1 min-w-0 border-t lg:border-t-0 border-neutral-200 dark:border-neutral-800">
          <nav className="hidden lg:flex sticky top-0 z-30 h-14 border-b border-neutral-200 dark:border-neutral-800 bg-white/90 dark:bg-black/90 backdrop-blur">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => go(t.href)}
                className={`flex-1 flex items-center justify-center font-geist-mono text-xs tracking-[0.12em] border-r border-neutral-200 dark:border-neutral-800 transition-colors ${
                  active === t.id
                    ? "text-neutral-900 dark:text-white shadow-[inset_0_-2px_0_currentColor]"
                    : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                }`}
              >
                {t.label}
              </button>
            ))}
            <button
              onClick={() => go("/auth")}
              className="flex-1 flex items-center justify-center gap-1.5 font-geist-mono text-xs tracking-[0.12em] bg-neutral-900 text-white dark:bg-white dark:text-black hover:opacity-90"
            >
              SIGN-IN <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </nav>

          <main className="px-4 sm:px-8 py-10 sm:py-12 space-y-16 max-w-4xl">{children}</main>

          <footer className="lg:hidden px-4 py-8 border-t border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
            <FooterLinks />
          </footer>
          <div className="px-4 sm:px-8 py-6 border-t border-neutral-200 dark:border-neutral-800 font-geist-mono text-[11px] tracking-wider text-neutral-500">
            © {new Date().getFullYear()} RECRUTAS · BUILT FOR US JOB SEEKERS
          </div>
        </div>
      </div>
    </div>
  );
}

function Wordmark({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-2" aria-label="Recrutas home">
      <RecrutasLogo size={22} />
      <span className="font-geist-mono text-sm tracking-[0.14em] font-medium">RECRUTAS.</span>
    </button>
  );
}

function FooterLinks() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 font-geist-mono text-xs text-neutral-500">
      {FOOTER_LINKS.map((l, i) => (
        <span key={l.label} className="flex items-center gap-3">
          {i > 0 && <span aria-hidden>/</span>}
          <a
            href={l.href}
            {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className="hover:text-neutral-900 dark:hover:text-white transition-colors"
          >
            {l.label}
          </a>
        </span>
      ))}
    </div>
  );
}

// Faint vertical rules that fade toward the edges — a flat stand-in for a hero
// image, drawn in CSS so the page ships no extra assets.
function LinesBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 text-neutral-900/[0.06] dark:text-white/[0.07]"
      style={{
        backgroundImage:
          "repeating-linear-gradient(90deg, currentColor 0 1px, transparent 1px 28px)",
        maskImage: "radial-gradient(ellipse 70% 55% at 60% 45%, black 10%, transparent 75%)",
        WebkitMaskImage: "radial-gradient(ellipse 70% 55% at 60% 45%, black 10%, transparent 75%)",
      }}
    />
  );
}

// -- Small building blocks shared by both pages --------------------------------

export function SectionLabel({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <div id={id} className="flex items-center gap-4 mb-6 scroll-mt-20">
      <h2 className="text-base font-medium tracking-tight shrink-0">{children}</h2>
      <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
    </div>
  );
}

export function MonoTag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "live" | "next" }) {
  const tones = {
    neutral: "border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400",
    live: "border-emerald-600/40 text-emerald-700 dark:border-emerald-400/40 dark:text-emerald-400",
    next: "border-amber-600/40 text-amber-700 dark:border-amber-400/40 dark:text-amber-400",
  } as const;
  return (
    <span className={`inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-geist-mono text-[10px] tracking-wider uppercase ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function PrimaryButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center justify-center gap-2 h-10 px-5 text-sm font-medium bg-neutral-900 text-white dark:bg-white dark:text-black hover:opacity-90 transition-opacity"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="relative inline-flex items-center justify-center gap-2 h-10 px-5 text-sm border border-neutral-300 dark:border-neutral-700 hover:border-neutral-900 dark:hover:border-white transition-colors"
    >
      {children}
      <span aria-hidden className="absolute -bottom-[3px] -right-[3px] w-1.5 h-1.5 bg-neutral-900 dark:bg-white" />
    </button>
  );
}
