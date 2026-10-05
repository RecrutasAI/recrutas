import { useQuery } from "@tanstack/react-query";
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

const UPDATE_TEXT: Record<WeeklySummaryData["updates"][number]["kind"], { text: string; cls: string }> = {
  taken_down: { text: "Taken down", cls: "text-red-700 dark:text-red-300" },
  reposted: { text: "Reposted: still looking", cls: "text-amber-700 dark:text-amber-300" },
  replied: { text: "Employer responded", cls: "text-emerald-700 dark:text-emerald-300" },
};

/**
 * This week in the candidate's search: what they applied to, what happened to
 * their applications, and new jobs they qualify for. The same summary is
 * available over MCP as `my_week`.
 */
export function WeeklySummaryCard() {
  const { data } = useQuery<WeeklySummaryData>({ queryKey: ["/api/candidate/weekly-summary"], staleTime: 5 * 60_000 });
  if (!data) {return null;}
  const applied = data.appliedThisWeek.length;
  return (
    <Card data-testid="weekly-summary">
      <CardContent className="p-4 sm:p-5 space-y-3">
        <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">Your week</h3>
        <div className="grid grid-cols-3 gap-3 text-center">
          {[
            [applied, applied === 1 ? "application" : "applications"],
            [data.waiting, "still waiting"],
            [data.newApplyMatches, data.newApplyMatches === 1 ? "new job you qualify for" : "new jobs you qualify for"],
          ].map(([n, label]) => (
            <div key={String(label)} className="rounded-md bg-slate-50 dark:bg-slate-900 px-2 py-3">
              <div className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{n}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
            </div>
          ))}
        </div>
        {data.updates.length > 0 && (
          <ul className="space-y-1 text-sm" data-testid="weekly-updates">
            {data.updates.map((u) => (
              <li key={`${u.kind}-${u.title}-${u.company}`} className="text-slate-700 dark:text-slate-300">
                <span className={`font-medium ${UPDATE_TEXT[u.kind].cls}`}>{UPDATE_TEXT[u.kind].text}:</span> {u.title} at {u.company}
              </li>
            ))}
          </ul>
        )}
        {data.waitingPastFollowUp > 0 && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {data.waitingPastFollowUp} {data.waitingPastFollowUp === 1 ? "is" : "are"} past the usual time to follow up.
          </p>
        )}
        {data.topMatches.length > 0 && (
          <div className="text-sm text-slate-700 dark:text-slate-300">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1">New this week, open to you</div>
            <ul className="space-y-0.5">
              {data.topMatches.map((j) => <li key={`${j.title}-${j.company}`}>{j.title} at {j.company}{j.location ? ` · ${j.location}` : ""}</li>)}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
