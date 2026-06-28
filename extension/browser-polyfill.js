/**
 * Minimal browser API polyfill for cross-browser extension compatibility.
 *
 * Firefox uses `browser.*` (Promise-based).
 * Chrome uses `chrome.*` (callback-based, but supports Promises in MV3).
 *
 * This polyfill ensures `chrome.*` calls work in Firefox by aliasing
 * `browser` → `chrome` when running in Firefox, and vice versa.
 */

(function () {
  'use strict';

  // Goal: a single Promise-based extension API available under BOTH `chrome`
  // and `browser` on every browser, so `await chrome.storage.local.get(...)`
  // works everywhere.
  //
  // Gotcha: modern Firefox (≈ v109+) exposes BOTH a Promise-based `browser` AND
  // a CALLBACK-based `chrome` compatibility shim. The old guard here only aliased
  // when `chrome` was undefined, so on modern Firefox it no-op'd and left
  // `chrome.*` callback-based — `await chrome.storage.local.get()` then resolved
  // to `undefined` and the background script blew up ("undefined has no
  // properties"). Fix: whenever `browser` exists (Firefox), point `chrome` at the
  // Promise-based `browser`, overriding the native callback shim.
  try {
    if (typeof globalThis.browser !== 'undefined' && globalThis.browser.runtime) {
      // Firefox: force `chrome` to the Promise-based `browser`.
      globalThis.chrome = globalThis.browser;
    } else if (typeof globalThis.chrome !== 'undefined') {
      // Chrome/Chromium: MV3 `chrome.*` is already Promise-based; expose `browser`.
      globalThis.browser = globalThis.chrome;
    }
  } catch (_e) {
    // Global may be read-only in some contexts; callers also fall back to `browser`.
  }
})();
