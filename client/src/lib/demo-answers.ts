import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { track } from "@/lib/analytics";

/** Where the homepage demo leaves the visitor's answers for after sign-up. */
export const DEMO_ANSWERS_KEY = "recrutas_demo_answers";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type YesNo = "yes" | "no";
export interface DemoAnswers { usCitizen?: YesNo; needsSponsorship?: YesNo; securityClearance?: "none" }

/** Reads the carried answers, dropping anything malformed or older than a week. */
export function readDemoAnswers(raw: string | null, now = Date.now()): DemoAnswers | null {
  if (!raw) {return null;}
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || typeof v.at !== "number" || now - v.at > MAX_AGE_MS) {return null;}
    const yn = (x: unknown): YesNo | undefined => (x === "yes" || x === "no" ? x : undefined);
    const out: DemoAnswers = {};
    if (yn(v.usCitizen)) {out.usCitizen = yn(v.usCitizen);}
    if (yn(v.needsSponsorship)) {out.needsSponsorship = yn(v.needsSponsorship);}
    if (v.securityClearance === "none") {out.securityClearance = "none";}
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/** Fills only the answers the candidate hasn't given yet; theirs always win. */
export function mergeDemoAnswers<T extends Record<string, unknown>>(existing: T, demo: DemoAnswers): T | null {
  const merged: Record<string, unknown> = { ...existing };
  let changed = false;
  for (const [k, v] of Object.entries(demo)) {
    if (merged[k] === undefined || merged[k] === "") { merged[k] = v; changed = true; }
  }
  return changed ? (merged as T) : null;
}

/**
 * After sign-up, saves the answers the visitor gave in the homepage demo as
 * their Application answers, so the dashboard starts where the demo left off.
 * The stored copy is removed once handled; on a failed request it stays (and
 * expires after a week) so the next dashboard load tries again.
 */
export function useCarryDemoAnswers(enabled: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) {return;}
    let raw: string | null = null;
    const forget = () => { try { localStorage.removeItem(DEMO_ANSWERS_KEY); } catch { /* blocked */ } };
    try { raw = localStorage.getItem(DEMO_ANSWERS_KEY); } catch { return; }
    if (raw === null) {return;}
    const demo = readDemoAnswers(raw);
    if (!demo) { forget(); return; }
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/candidate/application-answers");
        if (!res.ok) {return;}
        const { phone: _phone, ...existing } = await res.json();
        const merged = mergeDemoAnswers(existing, demo);
        if (merged && !(await apiRequest("PUT", "/api/candidate/application-answers", merged)).ok) {return;}
        forget();
        if (!merged) {return;}
        queryClient.invalidateQueries({ queryKey: ["/api/candidate/application-answers"] });
        track("demo_answers_carried", { fields: Object.keys(demo).length });
      } catch { /* kept for the next load; they can also answer in Settings */ }
    })();
  }, [enabled, queryClient]);
}
