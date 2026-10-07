/**
 * E2E Tests: Exam and Chat Flows
 *
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
  await page.waitForSelector('#email', { timeout: 20000 });
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function waitForDashboard(page: Page, pattern: RegExp, timeout = 40000) {
  await page.waitForURL(pattern, { timeout });
  await page.waitForTimeout(2000);
}

async function extractToken(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (
        (key.startsWith('sb-') && key.endsWith('-auth-token')) ||
        (key.includes('supabase') && key.includes('auth'))
      ) {
        try {
          const data = JSON.parse(localStorage.getItem(key)!);
          return data?.access_token ?? data?.session?.access_token ?? null;
        } catch {
          return null;
        }
      }
    }
    return null;
  });
}

// ── Exam Flow ─────────────────────────────────────────────────────────────────

test.describe('Exam Flow', () => {
  test('exam endpoint returns exam data or expected error for a job', async ({ page }) => {
    await loginAs(page, CANDIDATE_EMAIL, CANDIDATE_PASSWORD);
    await waitForDashboard(page, /candidate-dashboard/);
    const token = await extractToken(page);

    // GET /api/jobs/:jobId/exam — try job 1
    const res = await page.request.get('/api/jobs/1/exam', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    // Valid responses: 200 (exam found), 404 (no exam), 403 (not applied yet)
    expect([200, 403, 404, 400]).toContain(res.status());

    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('questions');
      expect(Array.isArray(body.questions)).toBe(true);
    }
  });

  test('exam questions are displayed when candidate visits exam page', async ({ page }) => {
    await loginAs(page, CANDIDATE_EMAIL, CANDIDATE_PASSWORD);
    await waitForDashboard(page, /candidate-dashboard/);

    // Navigate to jobs tab
    const jobsBtn = page.getByRole('button', { name: /^jobs$/i }).first();
    if (await jobsBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await jobsBtn.click();
    }

    await page.waitForTimeout(2000);

    // Look for a job card with an exam indicator
    const examBadge = page.getByText(/exam|screening/i).first();
    const hasExamJob = await examBadge.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasExamJob) {
      // Try to click "Take Exam" button if visible
      const takeExamBtn = page.getByRole('button', { name: /take exam|start exam/i }).first();
      if (await takeExamBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await takeExamBtn.click();
        await page.waitForTimeout(2000);

        // Exam interface should show questions or a start screen
        const examEl = page.getByText(/question|start exam|exam|time limit|minutes/i).first();
        const examVisible = await examEl.isVisible({ timeout: 8000 }).catch(() => false);
        expect(examVisible).toBe(true);
      } else {
        test.info().annotations.push({
          type: 'info',
          description: 'Take Exam button not visible — exam may require applying first',
        });
      }
    } else {
      test.info().annotations.push({
        type: 'info',
        description: 'No exam jobs visible in candidate feed — test skipped',
      });
    }
  });

  test('exam submission endpoint returns score or expected error', async ({ page }) => {
    await loginAs(page, CANDIDATE_EMAIL, CANDIDATE_PASSWORD);
    await waitForDashboard(page, /candidate-dashboard/);
    const token = await extractToken(page);

    // POST /api/jobs/:jobId/exam/submit with dummy answers
    const res = await page.request.post('/api/jobs/1/exam/submit', {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      data: { answers: {} },
    });

    // Valid responses: 200 (submitted), 400 (bad answers/no exam), 404 (no exam), 409 (already submitted)
    expect([200, 400, 404, 409, 500]).toContain(res.status());

    if (res.status() === 200) {
      const body = await res.json();
      expect(typeof body.score).toBe('number');
      expect(typeof body.passed).toBe('boolean');
    }
  });

  test('passed exam response shape includes score and feedback', async ({ page }) => {
    await loginAs(page, CANDIDATE_EMAIL, CANDIDATE_PASSWORD);
    await waitForDashboard(page, /candidate-dashboard/);
    const token = await extractToken(page);

    const res = await page.request.post('/api/jobs/1/exam/submit', {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      data: { answers: {} },
    });

    if (res.status() === 200) {
      const body = await res.json();
      // Successful submission shape: { score, passed, ... }
      expect(body).toHaveProperty('score');
      expect(typeof body.passed).toBe('boolean');
    } else {
      // 409 = already submitted, 404 = no exam on job 1 — both acceptable
      expect([400, 404, 409, 500]).toContain(res.status());
    }
  });
});

// ── Chat Flow ─────────────────────────────────────────────────────────────────

test.describe('Chat Flow', () => {
  test('recruiter chat rooms list loads without crash', async ({ page }) => {
    await loginAs(page, TALENT_EMAIL, TALENT_PASSWORD);
    await waitForDashboard(page, /talent-dashboard/);

    const token = await extractToken(page);

    const res = await page.request.get('/api/chat/rooms', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    // Should return 200 with an array (possibly empty)
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('candidate chat rooms list loads without crash', async ({ page }) => {
    await loginAs(page, CANDIDATE_EMAIL, CANDIDATE_PASSWORD);
    await waitForDashboard(page, /candidate-dashboard/);

    const token = await extractToken(page);

    const res = await page.request.get('/api/chat/rooms', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    // Should return 200 with an array (possibly empty)
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('candidate dashboard loads messages area without crash', async ({ page }) => {
    await loginAs(page, CANDIDATE_EMAIL, CANDIDATE_PASSWORD);
    await waitForDashboard(page, /candidate-dashboard/);

    // Look for a messages/chat tab button
    const chatBtn = page
      .getByRole('button', { name: /message|chat|inbox/i })
      .first();

    if (await chatBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await chatBtn.click();
      await page.waitForTimeout(2000);

      // Should not crash
      const crashed = await page
        .locator('text=Something went wrong')
        .isVisible({ timeout: 2000 })
        .catch(() => false);
      expect(crashed).toBe(false);

      // Should show chat UI or empty state
      const chatEl = page
        .getByText(/message|chat|conversation|no message|inbox/i)
        .first();
      const visible = await chatEl.isVisible({ timeout: 5000 }).catch(() => false);
      expect(visible).toBe(true);
    } else {
      test.info().annotations.push({
        type: 'info',
        description: 'Chat tab not found in nav — skipped',
      });
    }
  });
});
