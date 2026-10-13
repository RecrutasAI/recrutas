/**
 * The campaign code a visitor arrived with (?code=REDDIT-A1B2), kept until they sign up.
 *
 * The server tags a new account with it (users.signup_source / invite_code_used) only on the
 * request that creates the account. Email sign-ups create it after the confirmation link and
 * Google sign-ups after role selection, both long after the landing page, so the code has to
 * outlive the URL: it is saved here and sent as x-invite-code on API calls (queryClient).
 */
const KEY = 'recrutas_signup_code';
const MAX_AGE_MS = 30 * 86_400_000;
const VALID = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;

export function normalizeCode(raw: string | null | undefined): string {
  const code = (raw || '').trim().toUpperCase();
  return VALID.test(code) ? code : '';
}

/** Saves ?code= from the current URL, if any. The latest code wins. */
export function rememberSignupCode(search: string = window.location.search): void {
  const code = normalizeCode(new URLSearchParams(search).get('code'));
  if (!code) {return;}
  try { localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() })); } catch { /* storage blocked */ }
}

/** The code from the URL, else the saved one (up to 30 days old), else ''. */
export function getSignupCode(search: string = window.location.search): string {
  const fromUrl = normalizeCode(new URLSearchParams(search).get('code'));
  if (fromUrl) {return fromUrl;}
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && Date.now() - Number(saved.at) < MAX_AGE_MS) {return normalizeCode(saved.code);}
  } catch { /* storage blocked or bad JSON */ }
  return '';
}
