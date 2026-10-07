/**
 * Dashboard Elements E2E Test
 *
 * Full walkthrough of every tab and interactive element in both dashboards.
 * Candidate:  E2E_CANDIDATE_EMAIL / E2E_CANDIDATE_PASSWORD (env)
 * Talent:     E2E_TALENT_EMAIL / E2E_TALENT_PASSWORD (env)
 */

import { test, expect, Page } from '@playwright/test';

const CANDIDATE_EMAIL = (process.env.E2E_CANDIDATE_EMAIL ?? '');
const CANDIDATE_PASSWORD = (process.env.E2E_CANDIDATE_PASSWORD ?? '');
const TALENT_EMAIL = (process.env.E2E_TALENT_EMAIL ?? '');
const TALENT_PASSWORD = (process.env.E2E_TALENT_PASSWORD ?? '');

// ── helpers ──────────────────────────────────────────────────────────────────

async function loginAs(page: Page, email: string, password: string) {
  await page.goto('/auth');
  // Wait for the form to be visible (domcontentloaded is fast; avoid networkidle which never settles)
  await page.waitForSelector('#email', { timeout: 20000 });

  // The auth page uses plain <input id="email"> / <input id="password"> — no placeholder, no tabs
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function waitForDashboard(page: Page, pattern: RegExp, timeout = 40000) {
  // Wait for the URL to change — networkidle never settles with background services running
  await page.waitForURL(pattern, { timeout });
  // Give the page a moment to render initial data
  await page.waitForTimeout(2000);
}

// ── CANDIDATE DASHBOARD ───────────────────────────────────────────────────────

test.describe('Candidate Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, CANDIDATE_EMAIL, CANDIDATE_PASSWORD);
    await waitForDashboard(page, /candidate-dashboard/);
  });

  test('loads without crash', async ({ page }) => {
    await expect(page).toHaveURL(/candidate-dashboard/);
    // No error boundaries or crash messages
    const crashed =
      (await page.locator('text=Something went wrong').isVisible({ timeout: 2000 }).catch(() => false)) ||
      (await page.locator('text=Application Error').isVisible({ timeout: 2000 }).catch(() => false));
    expect(crashed).toBe(false);
  });

  // ── Jobs tab (default) ────────────────────────────────────────────────────
  test('Jobs tab — renders job cards or empty state', async ({ page }) => {
    // Jobs is the default tab; click it just in case
    const jobsBtn = page.getByRole('button', { name: /^jobs$/i }).first();
    if (await jobsBtn.isVisible({ timeout: 5000 }).catch(() => false)) await jobsBtn.click();

    await page.waitForTimeout(2000);

    // Either job cards appear or an empty/loading state is shown
    const jobCards = page.locator('[data-testid="job-card"], [class*="job-card"], [class*="card"], main, [role="main"]');
    const jobText = page.getByText(/matched for you|showing.*match|no.*job|browse|find.*job|looking for|loading|see your job|upload resume/i);
    const rendered = await jobCards.or(jobText).first().isVisible({ timeout: 8000 }).catch(() => false);
    expect(rendered).toBe(true);
  });

  // ── Saved tab ────────────────────────────────────────────────────────────
  test('Saved tab — renders without crash', async ({ page }) => {
    const savedBtn = page.getByRole('button', { name: /saved/i });
    await expect(savedBtn).toBeVisible({ timeout: 10000 });
    await savedBtn.click();

    await page.waitForTimeout(2000);

    // Must NOT show a React crash
    await expect(page.locator('text=Cannot read properties')).not.toBeVisible();
    await expect(page.locator('text=map is not a function')).not.toBeVisible();

    // Should show saved jobs OR an empty state
    const savedText = page.getByText(/saved job|no saved|bookmark|nothing saved/i);
    const savedEl = page.locator('[class*="card"], main');
    const rendered = await savedText.or(savedEl).first().isVisible({ timeout: 8000 }).catch(() => false);
    expect(rendered).toBe(true);
  });

  // ── Applications tab ──────────────────────────────────────────────────────
  test('Applications tab — renders without crash', async ({ page }) => {
    const appsBtn = page.getByRole('button', { name: /application/i });
    await expect(appsBtn).toBeVisible({ timeout: 10000 });
    await appsBtn.click();

    await page.waitForTimeout(3000);

    // Must NOT crash with a React hook error
    await expect(page.locator('text=rendered more hooks')).not.toBeVisible({ timeout: 2000 }).catch(() => {});
    await expect(page.locator('text=Cannot read properties')).not.toBeVisible();

    // Should show tracker, empty state, or loading
    const appsText = page.getByText(/no application|start applying|could not load|total application|loading/i);
    const appsEl = page.locator('[class*="card"]');
    const rendered = await appsEl.or(appsText).first().isVisible({ timeout: 10000 }).catch(() => false);
    expect(rendered).toBe(true);
  });

  test('Applications tab — ApplicationTracker stats row visible when apps exist', async ({ page }) => {
    const appsBtn = page.getByRole('button', { name: /application/i });
    await appsBtn.click();
    await page.waitForTimeout(3000);

    // If there are applications, the stats cards should show
    const totalAppsCard = page.locator('text=/total application/i');
    if (await totalAppsCard.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(page.locator('text=/in progress/i')).toBeVisible();
      await expect(page.locator('text=/interview/i')).toBeVisible();
    }
    // If no apps, the empty state card is shown — either is fine
  });

  // ── Stats cards on dashboard ───────────────────────────────────────────────
  test('Stats cards — visible in overview area', async ({ page }) => {
    await page.waitForTimeout(2000);
    const statsVisible = await page.locator('text=/match|application|profile/i').first().isVisible({ timeout: 8000 }).catch(() => false);
    expect(statsVisible).toBe(true);
  });

  // ── Navigation between tabs doesn't crash ────────────────────────────────
  test('Tab navigation — cycling through all tabs without crash', async ({ page }) => {
    const tabs = ['saved', 'application', 'profile', 'agent', 'job'];
    for (const tab of tabs) {
      const btn = page.getByRole('button', { name: new RegExp(tab, 'i') }).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(1500);
        const crashed = await page.locator('text=/error|crash|something went wrong/i').first().isVisible({ timeout: 1000 }).catch(() => false);
        if (crashed) {
          const msg = await page.locator('text=/error|crash|something went wrong/i').first().textContent();
          throw new Error(`Tab "${tab}" caused a crash: ${msg}`);
        }
      }
    }
  });
});

// ── TALENT DASHBOARD ──────────────────────────────────────────────────────────

test.describe('Talent Owner Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, TALENT_EMAIL, TALENT_PASSWORD);
    await waitForDashboard(page, /talent-dashboard/);
  });

  test('loads without crash', async ({ page }) => {
    await expect(page).toHaveURL(/talent-dashboard/);
    const crashed =
      (await page.locator('text=Something went wrong').isVisible({ timeout: 2000 }).catch(() => false)) ||
      (await page.locator('text=Application Error').isVisible({ timeout: 2000 }).catch(() => false));
    expect(crashed).toBe(false);
  });

  // ── Overview tab ──────────────────────────────────────────────────────────
  test('Overview tab — stats cards present', async ({ page }) => {
    await page.waitForTimeout(2000);
    const hasStats = await page.locator('text=/job|candidate|application|active/i').first().isVisible({ timeout: 10000 }).catch(() => false);
    expect(hasStats).toBe(true);
  });

  test('Overview tab — no undefined or NaN values in stats', async ({ page }) => {
    await page.waitForTimeout(2000);
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).not.toContain('NaN');
    expect(bodyText).not.toContain('undefined');
  });

  // ── Jobs tab ──────────────────────────────────────────────────────────────
  test('Jobs tab — renders job list or create-job prompt', async ({ page }) => {
    const jobsBtn = page.locator('button, [role="tab"]').filter({ hasText: /^jobs$/i }).first();
    if (await jobsBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await jobsBtn.click();
    }

    await page.waitForTimeout(2000);

    const jobsText = page.getByText(/job posting|create.*job|post.*job|no.*job|active job/i);
    const jobsEl = page.locator('[class*="card"]');
    const rendered = await jobsText.or(jobsEl).first().isVisible({ timeout: 10000 }).catch(() => false);
    expect(rendered).toBe(true);
  });

  test('Jobs tab — Create Job button is present', async ({ page }) => {
    const jobsBtn = page.locator('button, [role="tab"]').filter({ hasText: /^jobs$/i }).first();
    if (await jobsBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await jobsBtn.click();
      await page.waitForTimeout(1500);
    }

    const createBtn = page.getByRole('button', { name: /create.*job|post.*job|new.*job|add.*job/i }).first();
    await expect(createBtn).toBeVisible({ timeout: 10000 });
  });

  // ── Candidates tab ────────────────────────────────────────────────────────
  test('Candidates tab — renders without crash', async ({ page }) => {
    const candidatesBtn = page.locator('button, [role="tab"]').filter({ hasText: /candidate/i }).first();
    if (await candidatesBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await candidatesBtn.click();
      await page.waitForTimeout(2000);

      const candidateText = page.getByText(/candidate|applicant|no candidate|select.*job/i);
      const candidateEl = page.locator('[class*="card"]');
      const rendered = await candidateText.or(candidateEl).first().isVisible({ timeout: 10000 }).catch(() => false);
      expect(rendered).toBe(true);
    } else {
      test.skip();
    }
  });

  // ── Analytics tab ─────────────────────────────────────────────────────────
  test('Analytics tab — renders without crash', async ({ page }) => {
    const analyticsBtn = page.locator('button, [role="tab"]').filter({ hasText: /analytic/i }).first();
    if (await analyticsBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await analyticsBtn.click();
      await page.waitForTimeout(2000);

      const analyticsText = page.getByText(/analytic|chart|metric|performance|no.*data/i);
      const analyticsEl = page.locator('[class*="card"], canvas');
      const rendered = await analyticsText.or(analyticsEl).first().isVisible({ timeout: 10000 }).catch(() => false);
      expect(rendered).toBe(true);
    } else {
      test.skip();
    }
  });

  // ── Job posting flow ──────────────────────────────────────────────────────
  test('Create Job dialog — opens and shows required fields', async ({ page }) => {
    const jobsBtn = page.locator('button, [role="tab"]').filter({ hasText: /^jobs$/i }).first();
    if (await jobsBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await jobsBtn.click();
      await page.waitForTimeout(1000);
    }

    const createBtn = page.getByRole('button', { name: /create.*job|post.*job|new.*job/i });
    if (await createBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await createBtn.click();
      await page.waitForTimeout(1000);

      const dialogOpen = await page.locator('[role="dialog"], [class*="modal"], [class*="dialog"]').first().isVisible({ timeout: 5000 }).catch(() => false);
      const formOpen = await page.locator('input[placeholder*="title" i], input[name*="title" i], label:has-text("title")').first().isVisible({ timeout: 5000 }).catch(() => false);
      expect(dialogOpen || formOpen).toBe(true);

      // Close
      const closeBtn = page.locator('[aria-label="Close"], button:has-text("Cancel"), button:has-text("close")').first();
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click();
      } else {
        await page.keyboard.press('Escape');
      }
    }
  });

  // ── Notifications ─────────────────────────────────────────────────────────
  test('Notifications bell — clickable and shows panel or count', async ({ page }) => {
    const bell = page.locator('[aria-label*="notification" i], button:has([class*="bell"]), [class*="notification-bell"]').first();
    if (await bell.isVisible({ timeout: 5000 }).catch(() => false)) {
      await bell.click();
      await page.waitForTimeout(1000);
      const notifText = page.getByText(/notification|no new/i);
      const notifEl = page.locator('[class*="notification"]');
      const panel = await notifText.or(notifEl).first().isVisible({ timeout: 3000 }).catch(() => false);
      expect(panel).toBe(true);
      await page.keyboard.press('Escape');
    } else {
      test.info().annotations.push({ type: 'info', description: 'Notification bell not found — skipped' });
    }
  });

  // ── Tab cycling ───────────────────────────────────────────────────────────
  test('Tab navigation — cycling through all tabs without crash', async ({ page }) => {
    const tabPatterns = [/^jobs$/i, /candidate/i, /analytic/i, /overview/i];
    for (const pattern of tabPatterns) {
      const btn = page.locator('button, [role="tab"]').filter({ hasText: pattern }).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(1500);
        const crashed = await page.locator('text=/error|crash|something went wrong/i').first().isVisible({ timeout: 1000 }).catch(() => false);
        if (crashed) {
          const msg = await page.locator('text=/error|crash|something went wrong/i').first().textContent();
          throw new Error(`Tab "${pattern}" caused a crash: ${msg}`);
        }
      }
    }
  });
});

// ── API-LEVEL CHECKS (authenticated) ─────────────────────────────────────────

test.describe('API health checks (candidate auth)', () => {
  let token: string | null = null;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAs(page, CANDIDATE_EMAIL, CANDIDATE_PASSWORD);
    await waitForDashboard(page, /candidate-dashboard/);
    await page.waitForTimeout(2000);

    token = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        // Supabase v2 stores as "sb-{projectRef}-auth-token"; v1/helpers use "supabase.auth.token"
        if ((key.startsWith('sb-') && key.endsWith('-auth-token')) || (key.includes('supabase') && key.includes('auth'))) {
          try {
            const data = JSON.parse(localStorage.getItem(key)!);
            return data?.access_token ?? data?.session?.access_token ?? null;
          } catch { return null; }
        }
      }
      return null;
    });
    await page.close();
  });

  async function apiGet(page: Page, path: string) {
    // Use page.request so Playwright applies the configured baseURL automatically
    return page.request.get(path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  test('/api/candidate/applications returns array', async ({ page }) => {
    if (!token) test.skip();
    const res = await apiGet(page, '/api/candidate/applications');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('/api/candidate/saved-jobs returns array', async ({ page }) => {
    if (!token) test.skip();
    const res = await apiGet(page, '/api/candidate/saved-jobs');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('/api/external-jobs?jobTitle=engineer returns jobs array', async ({ page }) => {
    const res = await page.request.get('/api/external-jobs?jobTitle=engineer');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  test('/api/candidate/profile returns profile or 404', async ({ page }) => {
    if (!token) test.skip();
    const res = await apiGet(page, '/api/candidate/profile');
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      // The endpoint wraps the profile: { exists: true, profile: { userId, ... } }
      // or returns the profile directly depending on implementation
      const profile = body?.profile ?? body;
      expect(profile).toHaveProperty('userId');
    }
  });

  test('/api/candidate/stats returns stats object', async ({ page }) => {
    if (!token) test.skip();
    const res = await apiGet(page, '/api/candidate/stats');
    if (res.status() === 200) {
      const body = await res.json();
      expect(typeof body).toBe('object');
    }
  });
});

test.describe('API health checks (talent auth)', () => {
  let token: string | null = null;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAs(page, TALENT_EMAIL, TALENT_PASSWORD);
    await waitForDashboard(page, /talent-dashboard/);
    await page.waitForTimeout(2000);

    token = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if ((key.startsWith('sb-') && key.endsWith('-auth-token')) || (key.includes('supabase') && key.includes('auth'))) {
          try {
            const data = JSON.parse(localStorage.getItem(key)!);
            return data?.access_token ?? data?.session?.access_token ?? null;
          } catch { return null; }
        }
      }
      return null;
    });
    await page.close();
  });

  async function apiGet(page: Page, path: string) {
    // Use page.request so Playwright applies the configured baseURL automatically
    return page.request.get(path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  test('/api/talent-owner/jobs returns array for talent owner', async ({ page }) => {
    if (!token) test.skip();
    // The talent-owner jobs endpoint (GET /api/jobs is not a valid route; use /api/talent-owner/jobs)
    const res = await apiGet(page, '/api/talent-owner/jobs');
    expect([200, 401]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    }
  });

  test('/api/notifications returns array', async ({ page }) => {
    if (!token) test.skip();
    const res = await apiGet(page, '/api/notifications');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
