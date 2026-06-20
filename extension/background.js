/**
 * Recrutas Auto-Fill — Background Service Worker (MV3)
 *
 * Responsibilities:
 * - Store/retrieve auth token from chrome.storage.local
 * - Proxy login requests to Recrutas backend (no CORS issues from SW)
 * - Automatic token refresh before expiry
 * - Fetch candidate profile with Bearer token
 * - Proxy AI form-fill requests to backend
 * - Download resume files for form attachment
 * - Track fill stats
 * - Inject content script on demand (any site)
 * - Handle keyboard shortcut (Alt+Shift+R)
 */

const DEFAULT_RECRUTAS_URL = 'https://www.recrutas.ai';
const API_VERSION = 'v1'; // Message versioning for API compatibility

// ── Message version wrapper ───────────────────────────────────────────────────

function withVersion(msg) {
  return { ...msg, _version: API_VERSION };
}

// ── Installation cleanup ────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await cleanupOldCache();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getStoredAuth() {
  const data = await chrome.storage.local.get([
    'accessToken', 'refreshToken', 'expiresAt', 'recruitasUrl', 'userName', 'userEmail'
  ]);
  return data;
}

async function isTokenValid() {
  const { accessToken, expiresAt } = await getStoredAuth();
  if (!accessToken) return false;
  return expiresAt && Date.now() < (expiresAt - 60_000);
}

async function getRecruitasUrl() {
  const { recruitasUrl } = await getStoredAuth();
  return recruitasUrl || DEFAULT_RECRUTAS_URL;
}

// ── Token refresh ───────────────────────────────────────────────────────────

async function refreshAccessToken() {
  const { refreshToken } = await getStoredAuth();
  if (!refreshToken) throw new Error('No refresh token');

  const supabaseUrl = await getSupabaseUrl();
  if (!supabaseUrl) throw new Error('Cannot refresh — no Supabase URL');

  const baseUrl = await getRecruitasUrl();
  const res = await fetch(`${baseUrl}/api/auth/extension-refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) {
    await logout();
    throw new Error('Session expired. Please sign in again.');
  }

  const { accessToken, refreshToken: newRefresh, expiresAt, user } = await res.json();

  await chrome.storage.local.set({
    accessToken,
    refreshToken: newRefresh || refreshToken,
    expiresAt,
    userName: user?.name || (await getStoredAuth()).userName,
    userEmail: user?.email || (await getStoredAuth()).userEmail,
  });

  return accessToken;
}

async function getSupabaseUrl() {
  // We don't need this separately — refresh goes through our backend
  return true;
}

async function getValidToken() {
  const valid = await isTokenValid();
  if (valid) {
    const { accessToken } = await getStoredAuth();
    return accessToken;
  }

  // Try refresh with retry
  const { refreshToken } = await getStoredAuth();
  if (refreshToken) {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const delay = Math.pow(2, attempt) * 500;
        if (attempt > 0) await new Promise(r => setTimeout(r, delay));
        return await refreshAccessToken();
      } catch (err) {
        if (attempt === maxRetries - 1) {
          console.warn('[Recrutas] Token refresh failed after retries:', err.message);
        }
      }
    }
  }

  throw new Error('Not authenticated');
}

// ── Login ────────────────────────────────────────────────────────────────────

async function login(email, password) {
  const baseUrl = await getRecruitasUrl();
  const res = await fetch(`${baseUrl}/api/auth/extension-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Login failed (${res.status})`);
  }

  const { accessToken, refreshToken, expiresAt, user } = await res.json();

  await chrome.storage.local.set({
    accessToken,
    refreshToken,
    expiresAt,
    recruitasUrl: baseUrl,
    userName: user?.name || user?.email || email,
    userEmail: user?.email || email,
  });

  return { accessToken, userName: user?.name || user?.email || email };
}

// ── Logout ───────────────────────────────────────────────────────────────────

async function logout() {
  await chrome.storage.local.remove([
    'accessToken', 'refreshToken', 'expiresAt', 'userName', 'userEmail',
    'profileCache', 'profileCacheTime',
  ]);
}

// ── Cache cleanup ─────────────────────────────────────────────────────────────

async function cleanupOldCache() {
  const { profileCacheTime, fillStats } = await chrome.storage.local.get(['profileCacheTime', 'fillStats']);
  
  // Clean old profile cache (> 24 hours)
  if (profileCacheTime && Date.now() - profileCacheTime > 86400000) {
    await chrome.storage.local.remove(['profileCache', 'profileCacheTime']);
  }
  
  // Clean old fill stats (> 30 days)
  if (fillStats?.lastFillDate) {
    const daysSince = (Date.now() - new Date(fillStats.lastFillDate).getTime()) / 86400000;
    if (daysSince > 30) {
      await chrome.storage.local.remove(['fillStats']);
    }
  }
}

// ── Fetch profile (with cache) ───────────────────────────────────────────────

async function fetchProfile(forceRefresh = false) {
  // Check cache (5 min TTL)
  if (!forceRefresh) {
    const { profileCache, profileCacheTime } = await chrome.storage.local.get(['profileCache', 'profileCacheTime']);
    if (profileCache && profileCacheTime && Date.now() - profileCacheTime < 300_000) {
      return profileCache;
    }
  }

  const accessToken = await getValidToken();

  const baseUrl = await getRecruitasUrl();
  const res = await fetch(`${baseUrl}/api/candidate/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    await logout();
    throw new Error('Session expired. Please sign in again.');
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch profile (${res.status})`);
  }

  const body = await res.json();
  // Server returns { exists, profile } — unwrap to the inner profile object
  const profile = body && typeof body === 'object' && 'profile' in body ? body.profile : body;

  // Cache it
  await chrome.storage.local.set({ profileCache: profile, profileCacheTime: Date.now() });

  return profile;
}

// ── AI form fill ─────────────────────────────────────────────────────────────

async function captureScreenshot() {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 80 });
    return dataUrl.replace(/^data:image\/\w+;base64,/, '');
  } catch (err) {
    console.warn('[Recrutas] Screenshot capture failed:', err.message);
    return null;
  }
}

async function fillFormAI(fields, jobContext) {
  const accessToken = await getValidToken();

  const screenshot = await captureScreenshot();

  const baseUrl = await getRecruitasUrl();

  // The server caps its own AI work at ~50s worst case (profile load + retry +
  // AI timeout). Abort a hair past that so a stalled connection surfaces a clear
  // error instead of leaving the in-page "AI filling…" spinner running forever.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  let res;
  try {
    res = await fetch(`${baseUrl}/api/extension/fill-form`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ fields, jobContext, screenshot }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Form fill timed out — please try again.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401) {
    await logout();
    throw new Error('Session expired. Please sign in again.');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Form fill failed (${res.status})`);
  }

  return res.json();
}

// ── Download resume ──────────────────────────────────────────────────────────

async function downloadResume(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Resume download failed (${res.status})`);

    const blob = await res.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    const base64 = btoa(binary);

    const urlPath = new URL(url).pathname;
    const filename = urlPath.split('/').pop() || 'resume.pdf';
    const mimeType = blob.type || 'application/pdf';

    return { base64, filename, mimeType };
  } catch (err) {
    console.warn('[Recrutas] Resume download failed:', err.message);
    throw err;
  }
}

// ── Fill stats ──────────────────────────────────────────────────────────────

async function incrementFillStats(fieldsFilled) {
  const { fillStats } = await chrome.storage.local.get('fillStats');
  const stats = fillStats || { totalFills: 0, totalFields: 0, lastFillDate: null };
  stats.totalFills += 1;
  stats.totalFields += fieldsFilled;
  stats.lastFillDate = new Date().toISOString();
  await chrome.storage.local.set({ fillStats: stats });
  return stats;
}

// ── Telemetry ─────────────────────────────────────────────────────────────────

async function trackFillEvent(atsType, success, fieldsFilled, failedFields, error) {
  const { telemetry } = await chrome.storage.local.get('telemetry');
  const events = telemetry || [];
  
  events.push({
    timestamp: Date.now(),
    atsType,
    success,
    fieldsFilled,
    failedFields: failedFields?.length || 0,
    error: error || null,
  });
  
  // Keep only last 100 events
  const trimmed = events.slice(-100);
  await chrome.storage.local.set({ telemetry: trimmed });
}

async function getTelemetry() {
  const { telemetry } = await chrome.storage.local.get('telemetry');
  return telemetry || [];
}

// ── Inject content script into active tab ────────────────────────────────────

async function injectAndFill(tabId) {
  if (chrome.scripting) {
    // Chrome MV3 / Firefox MV3
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } else {
    // Firefox MV2 fallback
    await chrome.tabs.insertCSS(tabId, { file: 'content.css' });
    await chrome.tabs.executeScript(tabId, { file: 'browser-polyfill.js' });
    await chrome.tabs.executeScript(tabId, { file: 'content.js' });
  }
}

// ── Keyboard shortcut handler ───────────────────────────────────────────────

// Cross-browser badge API — Chrome MV3 uses chrome.action, Firefox MV2 uses browserAction
const actionAPI = chrome.action || chrome.browserAction;

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'fill-page') {
    const valid = await isTokenValid();
    if (!valid) {
      // Can't fill without auth — badge the icon
      if (actionAPI) {
        actionAPI.setBadgeText({ text: '!' });
        actionAPI.setBadgeBackgroundColor({ color: '#ef4444' });
        setTimeout(() => actionAPI.setBadgeText({ text: '' }), 3000);
      }
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    try {
      await injectAndFill(tab.id);
    } catch (err) {
      console.error('[Recrutas] Shortcut fill failed:', err.message);
    }
  }
});

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handle = async () => {
    switch (message.type) {
      case 'LOGIN': {
        const { email, password } = message;
        const result = await login(email, password);
        return { success: true, ...result };
      }

      case 'LOGOUT': {
        await logout();
        return { success: true };
      }

      case 'GET_STATUS': {
        const { accessToken, userName, userEmail } = await getStoredAuth();
        const valid = await isTokenValid();
        const { fillStats } = await chrome.storage.local.get('fillStats');
        return {
          authenticated: !!(accessToken && valid),
          userName: userName || null,
          userEmail: userEmail || null,
          fillStats: fillStats || { totalFills: 0, totalFields: 0 },
        };
      }

      case 'GET_PROFILE': {
        const profile = await fetchProfile(message.forceRefresh);
        return { success: true, profile };
      }

      case 'FILL_FORM_AI': {
        const result = await fillFormAI(message.fields, message.jobContext);
        return { success: true, ...result };
      }

      case 'FILL_COMPLETE': {
        const stats = await incrementFillStats(message.fieldsFilled || 0);
        
        // Track telemetry for this fill
        if (message.atsType) {
          await trackFillEvent(
            message.atsType,
            message.success || false,
            message.fieldsFilled || 0,
            message.failedFields || [],
            message.error || null
          );
        }
        
        return { success: true, stats };
      }

      case 'GET_TELEMETRY': {
        const events = await getTelemetry();
        return { success: true, events };
      }

      case 'DOWNLOAD_RESUME': {
        const file = await downloadResume(message.url);
        return { success: true, ...file };
      }

      case 'INJECT_AND_FILL': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('No active tab');
        await injectAndFill(tab.id);
        return { success: true };
      }

      case 'SET_RECRUTAS_URL': {
        await chrome.storage.local.set({ recruitasUrl: message.url });
        return { success: true };
      }

      default:
        return { success: false, error: 'Unknown message type' };
    }
  };

  handle()
    .then(sendResponse)
    .catch((err) => sendResponse({ success: false, error: err.message }));

  return true; // keep the message channel open
});
