import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

// Cloudflare Turnstile — the CAPTCHA Supabase Auth verifies on signup, password
// sign-in and password reset. Off until VITE_TURNSTILE_SITE_KEY is set, so the
// forms behave exactly as before in dev and until the key exists.
export const TURNSTILE_SITE_KEY: string | undefined = import.meta.env.VITE_TURNSTILE_SITE_KEY || undefined;
export const captchaEnabled = !!TURNSTILE_SITE_KEY;

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
  }
}

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) {return Promise.resolve();}
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { scriptPromise = null; reject(new Error("Turnstile failed to load")); };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

export interface TurnstileHandle {
  /** Tokens are single-use: call after every submit attempt. */
  reset: () => void;
}

interface TurnstileProps {
  onToken: (token: string | null) => void;
}

/** Renders nothing when CAPTCHA is disabled. */
export const Turnstile = forwardRef<TurnstileHandle, TurnstileProps>(function Turnstile({ onToken }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useImperativeHandle(ref, () => ({
    reset: () => {
      onTokenRef.current(null);
      if (widgetId.current && window.turnstile) {window.turnstile.reset(widgetId.current);}
    },
  }), []);

  useEffect(() => {
    if (!captchaEnabled || !container.current) {return;}
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !container.current || !window.turnstile) {return;}
        widgetId.current = window.turnstile.render(container.current, {
          sitekey: TURNSTILE_SITE_KEY,
          appearance: "interaction-only", // invisible unless Cloudflare needs a click
          callback: (token: string) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        });
      })
      .catch(() => onTokenRef.current(null));
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {window.turnstile.remove(widgetId.current);}
      widgetId.current = null;
    };
  }, []);

  if (!captchaEnabled) {return null;}
  return <div ref={container} className="flex justify-center" data-testid="turnstile" />;
});
