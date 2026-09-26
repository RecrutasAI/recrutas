import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import type { EmailOtpType } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/lib/supabase-client";

// Where each confirmed link type continues to.
const NEXT: Partial<Record<EmailOtpType, string>> = {
  recovery: "/reset-password",
  email_change: "/candidate-dashboard",
  email: "/candidate-dashboard",
  signup: "/auth",
  invite: "/auth",
  magiclink: "/auth",
};

/**
 * Landing page for links in auth emails: /auth/confirm?token_hash=…&type=…
 *
 * The Supabase default templates link to <project>.supabase.co/auth/v1/verify.
 * A recrutas.ai email pointing at a random-looking third-party domain is a
 * textbook phishing pattern, and Gmail flagged our reset email as "This
 * message might be dangerous". The templates now link here — our own domain —
 * and this page redeems the token with Supabase and moves on.
 */
export default function AuthConfirmPage() {
  const [, setLocation] = useLocation();
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenHash = params.get("token_hash");
    const type = params.get("type") as EmailOtpType | null;
    if (!tokenHash || !type || !(type in NEXT)) {
      setFailed("This link is incomplete.");
      return;
    }
    // Drop the token from the address bar/history before doing anything else.
    window.history.replaceState(null, "", "/auth/confirm");

    supabase.auth.verifyOtp({ token_hash: tokenHash, type }).then(({ error }) => {
      if (error) {
        setFailed(error.message);
        return;
      }
      setLocation(NEXT[type]!);
    });
  }, [setLocation]);

  if (!failed) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Confirming" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md border border-border shadow-lg">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">This link has expired or was already used</CardTitle>
          <CardDescription>
            Email links work once and expire after an hour. Request a new one below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Link href="/forgot-password">
            <Button className="w-full">Send a new password reset link</Button>
          </Link>
          <Link href="/auth">
            <Button variant="ghost" className="w-full">Back to sign in</Button>
          </Link>
          <p className="pt-2 text-center text-xs text-muted-foreground">{failed}</p>
        </CardContent>
      </Card>
    </div>
  );
}
