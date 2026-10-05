import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export interface WeeklySummaryData {
  appliedThisWeek: Array<{ title: string; company: string }>;
  updates: Array<{ kind: "taken_down" | "reposted" | "replied"; title: string; company: string }>;
  waiting: number;
  waitingPastFollowUp: number;
  newApplyMatches: number;
  topMatches: Array<{ title: string; company: string; location: string | null }>;
  nextStep: string | null;
}

export interface DiagnosisData {
  applications: number;
  enoughData: boolean;
  findings: string[];
  nextStep: { kind: string; text: string };
}

const UPDATE_TEXT: Record<WeeklySummaryData["updates"][number]["kind"], { text: string; cls: string }> = {
  taken_down: { text: "Taken down", cls: "text-red-700 dark:text-red-300" },
  reposted: { text: "Reposted, still looking", cls: "text-amber-700 dark:text-amber-300" },
  replied: { text: "Employer responded", cls: "text-emerald-700 dark:text-emerald-300" },
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The top of the Applications tab, in one panel: the totals, what happened
 * this week (the same summary MCP serves as `my_week`), one next step, and,
 * folded, why the candidate may not be hearing back.
 */
export function ApplicationsOverview({ total, interviews, offers }: { total: number; interviews: number; offers: number }) {
  const { data: week } = useQuery<WeeklySummaryData>({ queryKey: ["/api/candidate/weekly-summary"], staleTime: 5 * 60_000 });
  const { data: diagnosis } = useQuery<DiagnosisData>({ queryKey: ["/api/candidate/application-diagnosis"] });
  const [whyOpen, setWhyOpen] = useState(false);

  const totals = [
    plural(total, "application"),
    week ? `${week.waiting} waiting${week.waitingPastFollowUp ? ` (${week.waitingPastFollowUp} past follow-up)` : ""}` : null,
    interviews ? plural(interviews, "interview") : null,
    offers ? plural(offers, "offer") : null,
  ].filter(Boolean);
  const thisWeek = week ? [
    `${week.appliedThisWeek.length} applied`,
    week.newApplyMatches ? `${plural(week.newApplyMatches, "new job")} you qualify for` : null,
  ].filter(Boolean) : [];
  const nextStep = diagnosis ? `${diagnosis.enoughData ? "Next step: " : ""}${diagnosis.nextStep.text}` : week?.nextStep ? `Next step: ${week.nextStep}` : null;

  return (
    <Card data-testid="applications-overview">
      <CardContent className="p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100" data-testid="applications-totals">{totals.join(" · ")}</p>
          {thisWeek.length > 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400" data-testid="weekly-summary">This week: {thisWeek.join(" · ")}</p>
          )}
        </div>

        {week && week.updates.length > 0 && (
          <ul className="space-y-1 text-sm" data-testid="weekly-updates">
            {week.updates.map((u) => (
              <li key={`${u.kind}-${u.title}-${u.company}`} className="text-slate-700 dark:text-slate-300">
                <span className={`font-medium ${UPDATE_TEXT[u.kind].cls}`}>{UPDATE_TEXT[u.kind].text}:</span> {u.title} at {u.company}
              </li>
            ))}
          </ul>
        )}

        {nextStep && (
          <p className="text-sm rounded-md px-3 py-2 bg-blue-50 text-blue-900 dark:bg-blue-950/40 dark:text-blue-100" data-testid="diagnosis-next-step">{nextStep}</p>
        )}

        {diagnosis && diagnosis.findings.length > 0 && (
          <div data-testid="application-diagnosis">
            <button type="button" onClick={() => setWhyOpen(o => !o)} aria-expanded={whyOpen}
              className="flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
              Why you're not hearing back
              <ChevronDown className={`h-4 w-4 transition-transform ${whyOpen ? "rotate-180" : ""}`} />
            </button>
            {whyOpen && (
              <ul className="mt-2 space-y-1.5 text-sm text-slate-700 dark:text-slate-300 list-disc pl-5">
                {diagnosis.findings.map((f) => <li key={f}>{f}</li>)}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
