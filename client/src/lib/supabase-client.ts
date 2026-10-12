import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// A password-recovery link can land on ANY page: Supabase falls back to the
// Site URL (the home page) whenever the requested redirect isn't on its
// allow-list, and only /reset-password knows how to finish a recovery. Landing
// on "/" instead signed the user in and dropped them into the app without ever
// showing the new-password form. Move the recovery tokens to /reset-password
// before the client below parses the URL, so the page that handles them is the
// one that receives them.
if (
  typeof window !== 'undefined' &&
  /(^|[#&])type=recovery(&|$)/.test(window.location.hash) &&
  window.location.pathname !== '/reset-password'
) {
  window.history.replaceState(null, '', '/reset-password' + window.location.hash)
}

// Sign-in normally runs on Supabase. While it is down, the console can move it to our
// own backup server (useSiteStatus stores its address here and reloads the page). Both
// sign tokens with the same secret, so the rest of the app works with either.
export const AUTH_URL_KEY = 'recrutas-auth-url'
function storedAuthUrl(): string | null {
  try { return typeof window !== 'undefined' ? window.localStorage.getItem(AUTH_URL_KEY) : null } catch { return null }
}

export const supabase = createClient(storedAuthUrl() || supabaseUrl!, supabaseAnonKey!)
