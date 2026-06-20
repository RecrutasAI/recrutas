/**
 * Recrutas Auto-Fill — Popup Script
 *
 * Handles login, profile display, profile readiness, fill stats,
 * and the "Fill this page" action.
 */

const viewLoading = document.getElementById('view-loading');
const viewLogin   = document.getElementById('view-login');
const viewProfile = document.getElementById('view-profile');

function showView(name) {
  viewLoading.classList.add('hidden');
  viewLogin.classList.add('hidden');
  viewProfile.classList.add('hidden');
  if (name === 'loading') viewLoading.classList.remove('hidden');
  else if (name === 'login') viewLogin.classList.remove('hidden');
  else if (name === 'profile') viewProfile.classList.remove('hidden');
}

// Promise-based extension API. Firefox's chrome.* namespace is callback-style
// and does NOT return promises (so `await chrome.runtime.sendMessage(...)`
// resolves to undefined and the popup hangs on its spinner) — only browser.*
// does. The loaded browser-polyfill also exposes a promise-based `browser` on
// Chrome, so prefer it on both; fall back to chrome.* only if it's missing.
const api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

async function send(message) {
  return api.runtime.sendMessage(message);
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  showView('loading');

  // Never let the popup get stuck on the spinner: if GET_STATUS rejects or
  // returns nothing (cold service worker, messaging error), fall back to the
  // login view instead of throwing out of init().
  let status;
  try {
    status = await send({ type: 'GET_STATUS' });
  } catch {
    status = null;
  }

  if (status && status.authenticated) {
    document.getElementById('user-name').textContent = status.userName || 'Candidate';
    document.getElementById('user-email').textContent = status.userEmail || '';

    // Show fill stats
    if (status.fillStats && status.fillStats.totalFills > 0) {
      const statsEl = document.getElementById('fill-stats');
      const statsText = document.getElementById('stats-text');
      statsText.textContent = `${status.fillStats.totalFills} form${status.fillStats.totalFills !== 1 ? 's' : ''} filled · ${status.fillStats.totalFields} fields`;
      statsEl.classList.remove('hidden');
    }

    showView('profile');

    // Fetch profile in background to show readiness
    loadProfileStatus();
  } else {
    const { recruitasUrl } = await api.storage.local.get('recruitasUrl');
    if (recruitasUrl) {
      document.getElementById('recrutas-url').value = recruitasUrl;
    }
    showView('login');
  }
}

// ── Profile readiness check ──────────────────────────────────────────────────

async function loadProfileStatus() {
  const statusEl = document.getElementById('profile-status');
  statusEl.classList.remove('hidden');

  try {
    const response = await send({ type: 'GET_PROFILE' });

    if (!response.success) {
      showProfileItem('resume', false, 'Could not load profile');
      showProfileItem('skills', false, '—');
      return;
    }

    const profile = response.profile;

    // Resume status
    const hasResume = !!(profile?.resumeUrl || profile?.resumeText);
    showProfileItem(
      'resume',
      hasResume,
      hasResume ? 'Resume uploaded' : 'No resume — upload at recrutas.ai'
    );

    // Skills status
    const skills = Array.isArray(profile?.skills) ? profile.skills : [];
    showProfileItem(
      'skills',
      skills.length > 0,
      skills.length > 0 ? `${skills.length} skills detected` : 'No skills found'
    );

    // Profile completion percentage
    const completion = calculateProfileCompletion(profile);
    const completionEl = document.getElementById('profile-completion');
    if (completionEl) {
      completionEl.textContent = `${completion}% complete`;
      if (completion < 100) {
        completionEl.classList.remove('hidden');
      }
    }
  } catch {
    showProfileItem('resume', false, 'Could not check profile');
    showProfileItem('skills', false, '—');
  }
}

function calculateProfileCompletion(profile) {
  if (!profile) return 0;
  let completed = 0;
  const total = 6;
  if (profile.resumeUrl || profile.resumeText) completed++;
  if (profile.skills && profile.skills.length > 0) completed++;
  if (profile.experience) completed++;
  if (profile.location) completed++;
  if (profile.workType) completed++;
  if (profile.salaryMin && profile.salaryMax) completed++;
  return Math.round((completed / total) * 100);
}

function showProfileItem(name, ok, text) {
  document.getElementById(`${name}-icon`).textContent = ok ? '✓' : '⚠';
  document.getElementById(`${name}-icon`).className = `status-icon ${ok ? 'ok' : 'warn'}`;
  document.getElementById(`${name}-text`).textContent = text;
}

// ── Connect via website ───────────────────────────────────────────────────────
// SSO: the extension authenticates by mirroring the recrutas.ai web session
// (see recrutas-bridge.js). There is no in-popup credential entry.

document.getElementById('open-web-btn').addEventListener('click', async () => {
  const { recruitasUrl } = await api.storage.local.get('recruitasUrl');
  const base = recruitasUrl || 'https://www.recrutas.ai';
  window.open(`${base}/auth`, '_blank');
});

document.getElementById('recheck-link').addEventListener('click', (e) => {
  e.preventDefault();
  init();
});

// ── Fill this page ───────────────────────────────────────────────────────────

document.getElementById('fill-btn').addEventListener('click', async () => {
  const btn = document.getElementById('fill-btn');
  btn.disabled = true;
  btn.textContent = 'Injecting…';

  try {
    await send({ type: 'INJECT_AND_FILL' });
    btn.textContent = 'Filling…';
    setTimeout(() => window.close(), 800);
  } catch {
    btn.textContent = 'Failed — try again';
    btn.disabled = false;
    setTimeout(() => {
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
        Fill this page
      `;
    }, 2000);
  }
});

// ── Disconnect ────────────────────────────────────────────────────────────────

document.getElementById('disconnect-btn').addEventListener('click', async () => {
  await send({ type: 'LOGOUT' });
  showView('login');
});

// ── Advanced: save custom URL ─────────────────────────────────────────────────

document.getElementById('save-url-btn').addEventListener('click', async () => {
  const url = document.getElementById('recrutas-url').value.trim();
  if (!url) return;
  await send({ type: 'SET_RECRUTAS_URL', url });
  const btn = document.getElementById('save-url-btn');
  btn.textContent = 'Saved ✓';
  setTimeout(() => { btn.textContent = 'Save URL'; }, 1500);
});

// ── Run ───────────────────────────────────────────────────────────────────────

init();
