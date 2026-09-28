import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Upload } from "lucide-react";
import { SiteShell, SectionLabel, PrimaryButton, SecondaryButton } from "@/components/site/site-shell";

export default function ManifestoPage() {
  const [, setLocation] = useLocation();
  const start = () => setLocation("/auth");

  return (
    <SiteShell
      active="manifesto"
      left={
        <div className="max-w-md">
          <p className="font-geist-mono text-[11px] tracking-[0.14em] text-neutral-500 mb-5">MANIFESTO</p>
          <h1 className="text-[2.1rem] sm:text-[2.6rem] leading-[1.1] tracking-[-0.03em] font-normal mb-8">
            No one should have to beg for the right to earn a living.
          </h1>
          <div className="flex flex-wrap gap-3">
            <PrimaryButton onClick={start}>
              <Upload className="w-4 h-4" /> Upload résumé — free
            </PrimaryButton>
            <SecondaryButton onClick={() => { setLocation("/"); window.scrollTo(0, 0); }}>Back to README</SecondaryButton>
          </div>
        </div>
      }
    >
      <article className="max-w-2xl">
        <SectionLabel>Manifesto</SectionLabel>
        <div className="space-y-6 text-[17px] sm:text-lg leading-[1.75] text-neutral-700 dark:text-neutral-300">
          <p>
            Too many good people are sending hundreds of applications into the dark and hearing nothing
            back. No reply. No reason. Just silence. And slowly they start to believe the lie that
            silence tells them, that they are worthless.
          </p>
          <p>
            While they wait, they are fed leftovers. Stale postings for jobs already filled. Ghost
            listings for jobs that never existed. Reheated garbage dressed up as opportunity, costing
            them the one thing they can never get back, their time.
          </p>
          <p>
            <Strong>We do not accept this.</Strong> We do not believe there should be a wall of forms
            and filters standing between a person and the food they put on the table for their family.
            Finding honest work should never become a second job of suffering.
          </p>
          <p>
            So we built something different. <Strong>Real jobs, pulled straight from the source, made
            to fit you. No ghosts. No leftovers. No silence pretending to be a system.</Strong>
          </p>
          <p>
            This is only the beginning. We are building toward a world where no one is ever left
            waiting in the dark, where every application gets an answer.
          </p>
        </div>

        <div className="mt-12 pt-6 border-t border-neutral-200 dark:border-neutral-800 flex flex-wrap gap-x-8 gap-y-3">
          <button onClick={start} className="inline-flex items-center gap-1.5 font-geist-mono text-xs tracking-wider hover:underline">
            GET YOUR RANKED FEED <ArrowRight className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => { setLocation("/"); setTimeout(() => document.getElementById("roadmap")?.scrollIntoView(), 50); }}
            className="inline-flex items-center gap-1.5 font-geist-mono text-xs tracking-wider text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
          >
            SEE THE ROADMAP <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </article>
    </SiteShell>
  );
}

function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-medium text-neutral-900 dark:text-white">{children}</strong>;
}
