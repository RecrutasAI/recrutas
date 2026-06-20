/**
 * Recrutas Auto-Fill — Web Session Bridge
 *
 * Runs only on recrutas.ai. Reads the logged-in Supabase session that the web
 * app persists in localStorage and mirrors it into the extension, so a
 * candidate who is signed in on the website is automatically authenticated in
 * the extension — no separate login. Re-syncs on login / logout / token
 * refresh so the extension session tracks the web session.
 */
(function () {
  'use strict';

  // Promise-based API: browser.* on Firefox, chrome.* (MV3, promise-based) on
  // Chrome. (No polyfill needed — we only use runtime.sendMessage.)
  const api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

  function b64DecodeUtf8(b64) {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // supabase-js persists the session under `sb-<project-ref>-auth-token`.
  function readSession() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !/^sb-.*-auth-token$/.test(key)) continue;
        let raw = localStorage.getItem(key);
        if (!raw) continue;
        if (raw.startsWith('base64-')) raw = b64DecodeUtf8(raw.slice(7));
        const parsed = JSON.parse(raw);
        // v2 stores the session directly; v1 wrapped it in { currentSession }.
        const s = parsed?.access_token ? parsed : parsed?.currentSession;
        if (s?.access_token && s?.refresh_token) return s;
      }
    } catch {
      /* malformed/locked storage — treat as no session */
    }
    return null;
  }

  function toAuth(s) {
    const md = s.user?.user_metadata || {};
    const name = md.first_name
      ? `${md.first_name} ${md.last_name || ''}`.trim()
      : s.user?.email || null;
    return {
      accessToken: s.access_token,
      refreshToken: s.refresh_token,
      // supabase expires_at is unix seconds; the extension stores ms.
      expiresAt: s.expires_at ? s.expires_at * 1000 : Date.now() + (s.expires_in || 3600) * 1000,
      userName: name,
      userEmail: s.user?.email || null,
    };
  }

  // `undefined` = nothing reported yet, so the first run always reports the
  // current state (token string, or null = logged out). This makes logout
  // propagate even across a page reload, where in-memory state resets but the
  // page genuinely has no session — otherwise a stale session lingers in the
  // extension after the user signs out and the page reloads.
  let lastReported;
  function sync() {
    const s = readSession();
    const token = s ? s.access_token : null;
    if (token === lastReported) return; // no change since last report
    lastReported = token;
    if (token) {
      api.runtime.sendMessage({ type: 'SYNC_SESSION', auth: toAuth(s) }).catch(() => {});
    } else {
      api.runtime.sendMessage({ type: 'CLEAR_SESSION' }).catch(() => {});
    }
  }

  // Initial sync (slightly delayed so the web app finishes hydrating its
  // session into localStorage before we read), then react to auth changes. The
  // `storage` event only fires for changes made in OTHER tabs, so also re-check
  // on focus/visibility (covers same-tab login) and poll lightly to catch
  // periodic token refreshes. A transient missed read self-heals on the next tick.
  setTimeout(sync, 400);
  window.addEventListener('storage', (e) => { if (!e.key || /auth-token/.test(e.key)) sync(); });
  window.addEventListener('focus', sync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  setInterval(sync, 60_000);
})();
