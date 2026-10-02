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

// Start downloading as soon as a form that needs it is imported, not when it
// mounts — the check can't start until the script is here.
if (captchaEnabled && typeof window !== "undefined") {loadScript().catch(() => {});}

/** How long a submit waits for Cloudflare before giving up. */
const TOKEN_WAIT_MS = 30_000;

export interface TurnstileHandle {
  /**
   * The current token, or the next one once Cloudflare finishes its check.
   * null when the check fails or times out. Forms stay clickable and await
   * this on submit, instead of sitting disabled while the check runs.
   */
  getToken: () => Promise<string | null>;
  /** Tokens are single-use: call after every submit attempt. */
  reset: () => void;
}

interface TurnstileProps {
  onToken?: (token: string | null) => void;
}

/** Renders nothing when CAPTCHA is disabled. */
export const Turnstile = forwardRef<TurnstileHandle, TurnstileProps>(function Turnstile({ onToken }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const token = useRef<string | null>(null);
  const waiters = useRef<((t: string | null) => void)[]>([]);

  const settle = (t: string | null, wake: boolean) => {
    token.current = t;
    onTokenRef.current?.(t);
    if (!wake) {return;}
    const pending = waiters.current;
    waiters.current = [];
    pending.forEach((resolve) => resolve(t));
  };

  useImperativeHandle(ref, () => ({
    getToken: () => {
      if (!captchaEnabled || token.current) {return Promise.resolve(token.current);}
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.current = waiters.current.filter((w) => w !== done);
          resolve(null);
        }, TOKEN_WAIT_MS);
        const done = (t: string | null) => { clearTimeout(timer); resolve(t); };
        waiters.current.push(done);
      });
    },
    reset: () => {
      settle(null, false);
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
          callback: (t: string) => settle(t, true),
          "expired-callback": () => settle(null, false),
          "error-callback": () => settle(null, true),
        });
      })
      .catch(() => settle(null, true));
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {window.turnstile.remove(widgetId.current);}
      widgetId.current = null;
    };
  }, []);

  if (!captchaEnabled) {return null;}
  return <div ref={container} className="flex justify-center" data-testid="turnstile" />;
});
