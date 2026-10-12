import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

type YesNo = "yes" | "no";
export interface ApplicationAnswersData {
  phone?: string;
  workAuthorizedUS?: YesNo;
  needsSponsorship?: YesNo;
  usCitizen?: YesNo;
  over18?: YesNo;
  securityClearance?: "none" | "public_trust" | "secret" | "top_secret" | "ts_sci";
  willingToRelocate?: YesNo;
  noticePeriod?: string;
  desiredSalary?: string;
  driversLicense?: YesNo;
  languages?: string;
  backgroundCheck?: YesNo;
  /** Answers kept from application forms, by question wording. */
  custom?: Record<string, string>;
}

const YES_NO_QUESTIONS: { key: keyof ApplicationAnswersData; label: string }[] = [
  { key: "workAuthorizedUS", label: "Are you legally authorized to work in the US?" },
  { key: "needsSponsorship", label: "Will you now or in the future need visa sponsorship?" },
  { key: "usCitizen", label: "Are you a US citizen?" },
  { key: "over18", label: "Are you 18 or older?" },
  { key: "willingToRelocate", label: "Are you willing to relocate?" },
  { key: "driversLicense", label: "Do you have a valid driver's license?" },
  { key: "backgroundCheck", label: "Are you willing to undergo a background check or drug screen?" },
];

const CLEARANCES: { value: NonNullable<ApplicationAnswersData["securityClearance"]>; label: string }[] = [
  { value: "none", label: "None" },
  { value: "public_trust", label: "Public Trust" },
  { value: "secret", label: "Secret" },
  { value: "top_secret", label: "Top Secret" },
  { value: "ts_sci", label: "TS/SCI" },
];

/**
 * Answers that application forms ask on almost every job and that only the
 * candidate can give. The auto-fill extension uses them exactly; without them
 * it leaves these questions blank rather than guess.
 */
export function ApplicationAnswers() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<ApplicationAnswersData>({
    queryKey: ["/api/candidate/application-answers"],
  });
  const [answers, setAnswers] = useState<ApplicationAnswersData>({});
  useEffect(() => { if (data) {setAnswers(data);} }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", "/api/candidate/application-answers", answers);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/candidate/application-answers"] });
      toast({ title: "Answers saved", description: "The extension will use them on application forms." });
    },
    onError: () => toast({ title: "Couldn't save your answers", description: "Check your connection and try again.", variant: "destructive" }),
  });

  const set = <K extends keyof ApplicationAnswersData>(key: K, value: ApplicationAnswersData[K]) =>
    setAnswers((a) => ({ ...a, [key]: value }));

  if (isLoading) {
    return <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading answers…</div>;
  }

  return (
    <div className="space-y-4" data-testid="application-answers">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Application answers</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Most applications ask these. Answer once and the extension fills them on every form, however the question is worded. Anything you leave blank stays blank on the form.
        </p>
      </div>

      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="aa-phone" className="text-sm">Phone number</Label>
          <Input id="aa-phone" type="tel" autoComplete="tel" placeholder="(206) 555-0142"
            value={answers.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
        </div>

        {YES_NO_QUESTIONS.map(({ key, label }) => (
          <div key={key} className="grid sm:grid-cols-[1fr_140px] items-center gap-1.5 sm:gap-3">
            <Label htmlFor={`aa-${key}`} className="text-sm font-normal">{label}</Label>
            <Select value={(answers[key] as string) || undefined} onValueChange={(v) => set(key, v as never)}>
              <SelectTrigger id={`aa-${key}`} className="h-9"><SelectValue placeholder="Not answered" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="yes">Yes</SelectItem>
                <SelectItem value="no">No</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ))}

        <div className="grid sm:grid-cols-[1fr_140px] items-center gap-1.5 sm:gap-3">
          <Label htmlFor="aa-clearance" className="text-sm font-normal">Active security clearance</Label>
          <Select value={answers.securityClearance || undefined} onValueChange={(v) => set("securityClearance", v as ApplicationAnswersData["securityClearance"])}>
            <SelectTrigger id="aa-clearance" className="h-9"><SelectValue placeholder="Not answered" /></SelectTrigger>
            <SelectContent>
              {CLEARANCES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="aa-notice" className="text-sm">Notice period or earliest start</Label>
          <Input id="aa-notice" placeholder="2 weeks" maxLength={60}
            value={answers.noticePeriod ?? ""} onChange={(e) => set("noticePeriod", e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="aa-salary" className="text-sm">Desired salary</Label>
          <Input id="aa-salary" placeholder="$120,000 a year" maxLength={60}
            value={answers.desiredSalary ?? ""} onChange={(e) => set("desiredSalary", e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="aa-languages" className="text-sm">Languages you speak</Label>
          <Input id="aa-languages" placeholder="English (native), Spanish (conversational)" maxLength={120}
            value={answers.languages ?? ""} onChange={(e) => set("languages", e.target.value)} />
        </div>
      </div>

      {answers.custom && Object.keys(answers.custom).length > 0 && (
        <div className="grid gap-2" data-testid="kept-answers">
          <div>
            <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">Answers kept from forms</h4>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Questions you answered on a form and chose to keep. They fill again when a form asks the same question.
            </p>
          </div>
          <ul className="grid gap-1.5">
            {Object.entries(answers.custom).map(([question, value]) => (
              <li key={question} className="flex items-start justify-between gap-3 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2">
                <div className="min-w-0 text-sm">
                  <p className="text-slate-700 dark:text-slate-300 first-letter:uppercase break-words">{question}</p>
                  <p className="text-slate-900 dark:text-slate-100 font-medium break-words">{value}</p>
                </div>
                <Button type="button" variant="ghost" size="sm" className="shrink-0 h-8"
                  aria-label={`Remove the kept answer to: ${question}`}
                  onClick={() => setAnswers((a) => {
                    const custom = { ...(a.custom ?? {}) };
                    delete custom[question];
                    return { ...a, custom };
                  })}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save answers
        </Button>
      </div>
    </div>
  );
}
