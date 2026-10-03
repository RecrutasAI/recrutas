import { useEffect, useState } from "react";
import { Loader2, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { track } from "@/lib/analytics";

const DISMISS_KEY = "recrutas_us_gate_dismissed";

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function wasDismissed(): boolean {
  try { return sessionStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
}

interface UsOnlyGateProps {
  children: React.ReactNode;
}

/**
 * Recrutas lists US jobs only. Visitors whose IP country (Vercel edge header,
 * via /api/geo) is outside the US see this before the signup form, instead of
 * creating an account whose feed would have nothing for them.
 *
 * Soft by design: IP location is wrong for VPN users and for US job seekers
 * travelling abroad, so "I'm looking for US jobs" continues to the form.
 * Unknown country (local dev, lookup failure) shows the form.
 */
export function UsOnlyGate({ children }: UsOnlyGateProps) {
  const [country, setCountry] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(wasDismissed);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/geo")
      .then((r) => (r.ok ? r.json() : { country: null }))
      .then((d) => { if (!cancelled) {setCountry(d?.country ?? null);} })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const outsideUs = !!country && country !== "US";

  useEffect(() => {
    if (outsideUs && !dismissed) {track("us_gate_shown", { country });}
  }, [outsideUs, dismissed, country]);

  if (!outsideUs || dismissed) {return <>{children}</>;}

  const continueAnyway = (): void => {
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ }
    track("us_gate_continue", { country });
    setDismissed(true);
  };

  return <NonUsNotice country={country!} onContinue={continueAnyway} />;
}

function NonUsNotice({ country, onContinue }: { country: string; onContinue: () => void }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  const notifyMe = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setState("sending");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, source: `non-us:${country}` }),
      });
      setState(res.ok ? "done" : "error");
      if (res.ok) {track("us_gate_notify", { country });}
    } catch {
      setState("error");
    }
  };

  return (
    <div className="space-y-5" data-testid="us-only-gate">
      <div className="flex items-start gap-3">
        <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-foreground">Recrutas covers US jobs only, for now</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            It looks like you're visiting from {countryName(country)}. Every job in Recrutas comes from a US
            employer, so your matches would be empty. We'd rather tell you now than after you sign up.
          </p>
        </div>
      </div>

      {state === "done" ? (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">
          Thanks! We'll email you when Recrutas covers {countryName(country)}.
        </p>
      ) : (
        <form onSubmit={notifyMe} className="space-y-2">
          <label htmlFor="notify-email" className="text-sm font-medium text-foreground">
            Get an email when we expand
          </label>
          <div className="flex gap-2">
            <Input id="notify-email" type="email" required autoComplete="email" value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            <Button type="submit" disabled={state === "sending" || !email}>
              {state === "sending" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Notify me"}
            </Button>
          </div>
          {state === "error" && <p className="text-xs text-destructive">That didn't go through. Please try again.</p>}
        </form>
      )}

      <button type="button" onClick={onContinue} className="w-full text-center text-sm text-muted-foreground underline hover:text-foreground">
        I'm looking for jobs in the US. Continue to sign up
      </button>
    </div>
  );
}
