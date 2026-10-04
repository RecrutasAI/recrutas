import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";

export interface DiagnosisData {
  applications: number;
  enoughData: boolean;
  findings: string[];
  nextStep: { kind: string; text: string };
}

/**
 * "Why am I hearing nothing?": what the candidate's own applications show
 * (replies, take-downs, timing, fit) and one next step. Built from Recrutas's
 * data on their applications, not generic advice.
 */
export function ApplicationDiagnosis() {
  const { data } = useQuery<DiagnosisData>({ queryKey: ["/api/candidate/application-diagnosis"] });
  if (!data) {return null;}
  return (
    <Card data-testid="application-diagnosis">
      <CardContent className="p-4 sm:p-5 space-y-3">
        <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">Why you're not hearing back</h3>
        {data.findings.length > 0 && (
          <ul className="space-y-1.5 text-sm text-slate-700 dark:text-slate-300 list-disc pl-5">
            {data.findings.map((f) => <li key={f}>{f}</li>)}
          </ul>
        )}
        <p className="text-sm rounded-md px-3 py-2 bg-blue-50 text-blue-900 dark:bg-blue-950/40 dark:text-blue-100" data-testid="diagnosis-next-step">
          <span className="font-semibold">{data.enoughData ? "Next step: " : ""}</span>{data.nextStep.text}
        </p>
      </CardContent>
    </Card>
  );
}
