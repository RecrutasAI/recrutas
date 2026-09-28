import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { Upload } from "lucide-react";
import { SiteShell, Container, PrimaryButton } from "@/components/site/site-shell";

export default function ManifestoPage() {
  const [, setLocation] = useLocation();
  const start = () => setLocation("/auth");

  return (
    <SiteShell active="manifesto">
      <Container className="pt-16 pb-20 sm:pt-24 sm:pb-28">
        <article className="mx-auto max-w-2xl">
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400 mb-6">Manifesto</p>
          <h1 className="text-4xl sm:text-6xl font-semibold tracking-[-0.04em] leading-[1.05] mb-12">
            No one should have to beg for the right to earn a living.
          </h1>
          <div className="space-y-7 text-lg sm:text-xl leading-[1.7] text-neutral-700 dark:text-neutral-300">
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

          <div className="mt-14 pt-8 border-t border-neutral-200 dark:border-neutral-800 flex flex-col sm:flex-row sm:items-center gap-5 sm:gap-8">
            <PrimaryButton onClick={start}>
              <Upload className="w-4 h-4" /> Get your ranked feed
            </PrimaryButton>
          </div>
        </article>
      </Container>
    </SiteShell>
  );
}

function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-neutral-900 dark:text-white">{children}</strong>;
}
