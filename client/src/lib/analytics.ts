import posthog from 'posthog-js';

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || 'https://us.i.posthog.com';

let initialized = false;

/**
 * Which deployment is firing this event.
 *
 * Why this exists: local development and prod share ONE PostHog project, while
 * their writes go to DIFFERENT databases (local `.env` points at Supabase, prod
 * runs on the Hetzner box). That made the activation funnel unreadable — over
 * one 30-day window PostHog counted 13 `signup_completed` against 3 real rows
 * in the prod users table, and there was no way to tell which events were a
 * developer testing the flow.
 *
 * Stamped on every event as a super property so prod can be isolated with a
 * single `env = production` filter. Derived from the hostname rather than
 * `import.meta.env.MODE`, because a production BUILD run locally still reports
 * MODE=production and would be counted as real traffic.
 */
function detectEnv(): 'production' | 'preview' | 'development' {
  const override = import.meta.env.VITE_POSTHOG_ENV as string | undefined;
  if (override) return override as 'production' | 'preview' | 'development';
  if (typeof window === 'undefined') return 'development';

  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local')) {
    return 'development';
  }
  if (/^(www\.)?recrutas\.ai$/i.test(host) || host === 'recrutas.vercel.app') {
    return 'production';
  }
  // Vercel preview/branch deploys: recrutas-<hash>-<scope>.vercel.app
  if (host.endsWith('.vercel.app')) return 'preview';
  return 'development';
}

export const analyticsEnv = detectEnv();

export function initAnalytics() {
  if (initialized || !KEY || typeof window === 'undefined') return;
  posthog.init(KEY, {
    api_host: HOST,
    capture_pageview: true,
    capture_pageleave: true,
    person_profiles: 'identified_only',
  });
  // Super properties: applied to every event from this client, including the
  // autocaptured $pageview/$pageleave that never pass through track().
  posthog.register({ env: analyticsEnv, app_host: window.location.hostname });
  initialized = true;
}

export function identify(userId: string, traits?: Record<string, any>) {
  if (!initialized) return;
  posthog.identify(userId, { env: analyticsEnv, ...traits });
}

export function reset() {
  if (!initialized) return;
  posthog.reset();
}

export function track(event: string, props?: Record<string, any>) {
  if (!initialized) return;
  posthog.capture(event, props);
}
