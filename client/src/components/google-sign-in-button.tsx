import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/lib/supabase-client";

interface GoogleSignInButtonProps {
  label?: string;
}

const GIS_SRC = "https://accounts.google.com/gsi/client";
// How long to wait for Google's script before falling back to the redirect
// button (ad blockers and some in-app browsers never load it).
const GIS_LOAD_TIMEOUT_MS = 5000;

let gisScript: Promise<void> | null = null;

function loadGoogleIdentityServices(): Promise<void> {
  if ((window as any).google?.accounts?.id) {return Promise.resolve();}
  gisScript ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = GIS_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { gisScript = null; reject(new Error("Google sign-in script failed to load")); };
    document.head.appendChild(el);
  });
  return gisScript;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * "Continue with Google". Works for both sign-in and sign-up: a first-time
 * Google user lands on /auth, which routes a role-less account to role
 * selection (that step creates the app's user row via /api/auth/role).
 * No password means nothing to forget — the most common account problem.
 *
 * With VITE_GOOGLE_CLIENT_ID set, this is Google's own button: sign-in happens
 * in a Google popup on our page and the ID token goes to Supabase
 * (signInWithIdToken). The redirect flow sent users through
 * fgdx….supabase.co/auth/v1/callback, so Google's screen said "continue to
 * fgdx….supabase.co"; the popup names our site instead. Without the env var,
 * or if Google's script can't load, it falls back to the redirect flow.
 */
export function GoogleSignInButton({ label = "Continue with Google" }: GoogleSignInButtonProps): JSX.Element {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  const [useRedirect, setUseRedirect] = useState(!clientId);

  if (useRedirect || !clientId) {return <GoogleRedirectButton label={label} />;}
  return <GoogleIdentityButton clientId={clientId} label={label} onUnavailable={() => setUseRedirect(true)} />;
}

function GoogleIdentityButton({ clientId, label, onUnavailable }: {
  clientId: string;
  label: string;
  onUnavailable: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => { if (!cancelled) {onUnavailable();} }, GIS_LOAD_TIMEOUT_MS);

    (async () => {
      try {
        // Google gets the hash; Supabase gets the raw value and checks the
        // token's nonce claim against its hash, so a replayed token fails.
        const rawNonce = crypto.randomUUID();
        const [hashedNonce] = await Promise.all([sha256Hex(rawNonce), loadGoogleIdentityServices()]);
        if (cancelled || !containerRef.current) {return;}
        const gis = (window as any).google.accounts.id;
        gis.initialize({
          client_id: clientId,
          nonce: hashedNonce,
          ux_mode: "popup",
          use_fedcm_for_button: true,
          callback: async ({ credential }: { credential?: string }) => {
            if (!credential) {return;}
            setSigningIn(true);
            const { error } = await supabase.auth.signInWithIdToken({ provider: "google", token: credential, nonce: rawNonce });
            if (error) {
              setSigningIn(false);
              toast({ title: "Google sign-in failed", description: error.message, variant: "destructive" });
              return;
            }
            // /auth routes the session by role, same as the redirect flow's return.
            setLocation("/auth");
          },
        });
        gis.renderButton(containerRef.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          shape: "rectangular",
          text: /sign up/i.test(label) ? "signup_with" : "continue_with",
          logo_alignment: "center",
          width: Math.min(400, containerRef.current.offsetWidth || 400),
        });
        clearTimeout(timeout);
        setReady(true);
      } catch {
        clearTimeout(timeout);
        if (!cancelled) {onUnavailable();}
      }
    })();

    return () => { cancelled = true; clearTimeout(timeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  return (
    <div className="w-full flex justify-center min-h-[44px] items-center" aria-busy={!ready || signingIn}>
      {signingIn ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
      <div ref={containerRef} className={signingIn ? "hidden" : "w-full flex justify-center"} data-testid="google-gis-button" />
      {!ready && !signingIn ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
    </div>
  );
}

function GoogleRedirectButton({ label }: { label: string }): JSX.Element {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  const handleClick = async (): Promise<void> => {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth` },
    });
    // On success the browser navigates away to Google; only errors return here.
    if (error) {
      setLoading(false);
      toast({ title: "Google sign-in failed", description: error.message, variant: "destructive" });
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className="w-full inline-flex items-center justify-center gap-2 py-2 px-4 border border-input rounded-md shadow-sm bg-background text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ring disabled:opacity-60"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
          <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.77.43 3.45 1.18 4.94l3.66-2.84z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
        </svg>
      )}
      {label}
    </button>
  );
}

export function OrDivider(): JSX.Element {
  return (
    <div className="relative my-6" aria-hidden="true">
      <div className="absolute inset-0 flex items-center">
        <div className="w-full border-t border-border" />
      </div>
      <div className="relative flex justify-center text-xs uppercase">
        <span className="bg-card px-2 text-muted-foreground">or</span>
      </div>
    </div>
  );
}
