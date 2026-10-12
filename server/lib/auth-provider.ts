/**
 * Which sign-in server the site uses (console switch `authProvider`): Supabase normally,
 * our own backup on the VPS (infra/vps/auth) when Supabase is down. Both sign tokens with
 * the same secret, so the API accepts either; only sign-in, sign-up and token renewal
 * go to the active one.
 */
import { getSettings } from '../services/runtime-settings.service';

/** Our backup sign-in server's public base URL (Caddy maps /auth/v1/* to it, like Supabase). */
export const BACKUP_AUTH_URL = (process.env.BACKUP_AUTH_URL || 'https://auth.recrutas.ai').replace(/\/$/, '');

/** Base URL of the active sign-in server; its endpoints live under /auth/v1. */
export async function activeAuthBaseUrl(): Promise<string | undefined> {
  const { authProvider } = await getSettings();
  return authProvider === 'recrutas' ? BACKUP_AUTH_URL : process.env.SUPABASE_URL;
}
