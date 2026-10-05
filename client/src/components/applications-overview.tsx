import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export interface DiagnosisData {
  applications: number;
  enoughData: boolean;
  answers: { replied: number; takenDown: number; reposted: number; waiting: number; waitingPastFollowUp: number };
  findings: string[];
  nextStep: { kind: string; text: string };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The top of the Applications tab, in one panel: the totals, one next step,
 * and, folded, why the candidate may not be hearing back. (What happened to
 * each application is on its own card; the weekly recap is MCP's `my_week`.)
 */
export function ApplicationsOverview({ total, interviews, offers }: { total: number; interviews: number; offers: number }) {
  const { data: diagnosis } = useQuery<DiagnosisData>({ queryKey: ["/api/candidate/application-diagnosis"] });
  const [whyOpen, setWhyOpen] = useState(false);

  const a = diagnosis?.answers;
  const totals = [
    plural(total, "application"),
    a ? `${a.waiting} waiting${a.waitingPastFollowUp ? ` (${a.waitingPastFollowUp} past follow-up)` : ""}` : null,
    interviews ? plural(interviews, "interview") : null,
    offers ? plural(offers, "offer") : null,
  ].filter(Boolean);

  return (
    <Card data-testid="applications-overview">
      <CardContent className="p-4 sm:p-5 space-y-3">
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100" data-testid="applications-totals">{totals.join(" · ")}</p>

        {diagnosis && (
          <p className="text-sm rounded-md px-3 py-2 bg-blue-50 text-blue-900 dark:bg-blue-950/40 dark:text-blue-100" data-testid="diagnosis-next-step">
            {diagnosis.enoughData ? "Next step: " : ""}{diagnosis.nextStep.text}
          </p>
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
