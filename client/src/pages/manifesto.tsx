import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { Upload } from "lucide-react";
import { SiteShell, Band, SectionLabel, PrimaryButton } from "@/components/site/site-shell";

const RULE = "border-neutral-200 dark:border-neutral-800";

// The build order is the launch plan: each phase ships when the one before it
// works for real people. Status labels must stay true to what is live.
const STEPS: { n: string; status: string; live?: boolean; body: ReactNode }[] = [
  {
    n: "step one",
    status: "live today",
    live: true,
    body: <>Give job seekers a feed they can trust: live US roles, straight from the source, ranked against their resume, each one telling you why it fits.</>,
  },
  {
    n: "step two",
    status: "next",
    body: <>Open the other side. Companies post roles on Recrutas, and candidates take a short exam generated from the job itself: the company's own bar, not a generic test. Everyone who passes hears back within 24 hours, with a direct line to the hiring manager.<Fn n={6} /></>,
  },
  {
    n: "step three",
    status: "started · extension live",
    body: <>Be everywhere you already are. Recrutas stops being a site you visit and becomes a layer: on any application form, inside the AI tools you already use, through an open API, and on your phone. Your matches, one call away from wherever you are.<Fn n={7} /></>,
  },
  {
    n: "step four",
    status: "where this goes",
    body: <>Make searching disappear. An agent that works for you around the clock, watching every company's board, applying where you'd want to, and bringing back only answers and interviews. You don't look for work. The right work finds you.<Fn n={8} /></>,
  },
];

const NOTES: ReactNode[] = [
  <>Not on who you know, which keywords you guessed, or how many times you can retype the same work history.</>,
  <>An answer means a reply to every application, even a no.</>,
  <>As of September 2026, counting only roles we read directly from employers' own career pages. US roles only, for now.</>,
  <>The cover letter nobody reads is the whip socket of hiring.</>,
  <>Greenhouse, Lever, Ashby, SmartRecruiters and more. No aggregators, no reposters.</>,
  <>Built, and waiting for its first employers. We won't open it until we can keep the promise.</>,
  <>The Auto-Fill extension is live on Firefox today. An MCP server and a public API are next.</>,
  <>Nothing is ever sent in your name without your say-so. An agent you can't trust is just another way to be ignored.</>,
];

export default function ManifestoPage() {
  const [, setLocation] = useLocation();
  const start = () => setLocation("/auth");

  return (
    <SiteShell active="manifesto">
      <Band className="border-t-0" inner="px-4 sm:px-10 pt-16 pb-20 sm:pt-24 sm:pb-28">
        <article className="mx-auto max-w-2xl">
          <SectionLabel>our mission</SectionLabel>
          <h1 className="text-4xl sm:text-6xl font-semibold tracking-[-0.04em] leading-[1.05] mb-10">
            No one should have to beg for the right to earn a living.
          </h1>
          <Prose>
            <p>
              Our mission is to make finding honest work depend on what you can do, not on how many forms
              you can survive<Fn n={1} />, by turning hiring from a black box into a system that
              answers.<Fn n={2} />
            </p>
          </Prose>

          <Section label="we already have the jobs">
            <p>
              The problem was never a shortage of openings. On any given day we track more than 140,000
              live roles from over 4,000 companies<Fn n={3} />, and those are only the ones employers post
              themselves.
            </p>
            <p>
              Yet too many good people are sending hundreds of applications into the dark and hearing
              nothing back. No reply. No reason. Just silence. And slowly they start to believe the lie that
              silence tells them, that they are worthless.
            </p>
            <p>
              That should tell us something: <Strong>the bottleneck isn't the number of jobs. It's that the
              system standing between a person and a job can't be trusted.</Strong>
            </p>
          </Section>

          <Section label="beyond classified ads">
            <p>
              The first online job boards were newspaper classifieds with a search box. Instead of
              rethinking how people and work find each other, they moved the listing onto a screen and kept
              everything else: the scrolling, the keyword guessing, the anonymous "apply" that disappears
              into a pile.<Fn n={4} />
            </p>
            <p>
              The pile only grew. While people wait, they are fed leftovers. Stale postings for jobs already
              filled. Ghost listings for jobs that never existed. Reheated garbage dressed up as
              opportunity, costing them the one thing they can never get back, their time.
            </p>
            <p>
              <Strong>We do not accept this.</Strong> We do not believe there should be a wall of forms and
              filters standing between a person and the food they put on the table for their family.
              Finding honest work should never become a second job of suffering.
            </p>
          </Section>

          <Section label="trust before scale">
            <p>
              You only act on what you trust. A listing is worth your evening only if the job is real,
              still open, and actually fits. And an application is worth sending only if someone will
              answer it.
            </p>
            <p>
              So we built from the bottom up. Every job comes straight from the employer's own hiring
              system, and we re-read every board every few hours.<Fn n={5} /> A job carries the live badge
              only if we saw it in the last 36 hours; when a company takes a posting down, we close it too.
              Every match is ranked against your resume and tells you why it fits.
            </p>
            <p>
              <Strong>Real jobs, pulled straight from the source, made to fit you. No ghosts. No leftovers.
              No silence pretending to be a system.</Strong>
            </p>
          </Section>

          <Section label="the order we're building it in">
            <p>Each step ships when the one before it works for real people.</p>
          </Section>
          <ol className={`mt-6 border-t border-l ${RULE}`}>
            {STEPS.map((s) => (
              <li key={s.n} className={`grid sm:grid-cols-[150px_1fr] gap-x-6 gap-y-2 p-5 sm:p-6 border-r border-b ${RULE}`}>
                <div>
                  <div className="font-geist-mono text-[11px] uppercase tracking-[0.14em] text-neutral-900 dark:text-white">{s.n}</div>
                  <div className={`font-geist-mono text-[10px] uppercase tracking-[0.14em] mt-1 ${
                    s.live ? "text-emerald-600 dark:text-emerald-400" : "text-neutral-500"
                  }`}>
                    {s.live && "● "}{s.status}
                  </div>
                </div>
                <p className="text-[15px] sm:text-base leading-[1.7] text-neutral-700 dark:text-neutral-300">{s.body}</p>
              </li>
            ))}
          </ol>

          <div className="mt-14">
            <Prose>
              <p>
                This is only the beginning. We are building toward a world where no one is ever left
                waiting in the dark, where every application gets an answer.
              </p>
            </Prose>
            <p className="mt-10 text-3xl sm:text-4xl font-semibold tracking-[-0.03em] leading-tight">
              We're building <span className="text-emerald-600 dark:text-emerald-400">answers</span>, not listings.
            </p>
            <div className="mt-10">
              <PrimaryButton onClick={start}>
                <Upload className="w-4 h-4" /> Get your ranked feed
              </PrimaryButton>
            </div>
          </div>

          <section className={`mt-20 pt-8 border-t ${RULE}`} aria-label="Notes">
            <div className="font-geist-mono text-[11px] uppercase tracking-[0.16em] text-neutral-500 mb-5">appendix</div>
            <ol className="space-y-3">
              {NOTES.map((note, i) => (
                <li key={i} id={`fn-${i + 1}`} className="flex gap-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400 scroll-mt-20">
                  <span className="font-geist-mono text-[11px] text-emerald-600 dark:text-emerald-400 pt-0.5 w-4 shrink-0">{i + 1}</span>
                  <span>{note}</span>
                </li>
              ))}
            </ol>
          </section>
        </article>
      </Band>
    </SiteShell>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-16">
      <SectionLabel>{label}</SectionLabel>
      <Prose>{children}</Prose>
    </section>
  );
}

function Prose({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6 text-lg sm:text-xl leading-[1.7] text-neutral-700 dark:text-neutral-300">
      {children}
    </div>
  );
}

function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-neutral-900 dark:text-white">{children}</strong>;
}

function Fn({ n }: { n: number }) {
  return (
    <sup className="ml-0.5">
      <a
        href={`#fn-${n}`}
        onClick={(e) => { e.preventDefault(); document.getElementById(`fn-${n}`)?.scrollIntoView({ behavior: "smooth" }); }}
        className="font-geist-mono text-[0.6em] text-emerald-600 dark:text-emerald-400 no-underline hover:underline"
        aria-label={`Note ${n}`}
      >
        {n}
      </a>
    </sup>
  );
}
