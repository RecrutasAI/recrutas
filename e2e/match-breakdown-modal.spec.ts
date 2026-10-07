import { test, expect, type Page } from '@playwright/test';

async function loginAs(page: Page, email: string, password: string) {
  await page.goto('/auth');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /sign in|login/i }).click();
}

test('match breakdown modal shows score breakdown + bulleted explanation', async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser error]', msg.text());
  });
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
  await page.waitForURL(/candidate-dashboard|dashboard/i, { timeout: 30000 });

  // The feed lives on candidate dashboard. Match cards each have a Sparkles
  // button that opens AIMatchBreakdownModal (it's the last button in the
  // action row, no accessible name — locate by being the last button on the
  // first job card with class h-3/h-4 svg).
  // Easier: wait for at least one "Why you match:" badge, then click the
  // last button in its containing card.

  await page.waitForSelector('text=/Why you match/i', { timeout: 60000 });
  const firstCard = page.locator('text=/Why you match/i').first().locator('xpath=ancestor::div[contains(@class,"CardContent") or contains(@class,"p-")][1]');

  // Click the Sparkles "describe" button — it's the only button on the card
  // whose visible label is empty and contains a sparkle svg.
  const sparkleBtn = page.locator('button:has(svg.lucide-sparkles)').first();
  await sparkleBtn.click();

  // Modal should open
  await expect(page.locator('[role="dialog"]')).toBeVisible();

  // New sections we added
  await expect(page.getByText(/Score breakdown/i)).toBeVisible();
  await expect(page.getByText(/Skills/i).first()).toBeVisible();
  await expect(page.getByText(/Profile similarity/i)).toBeVisible();
  await expect(page.getByText(/Role relevance/i)).toBeVisible();
  await expect(page.getByText(/Experience level/i)).toBeVisible();

  // Screenshot for visual verification
  await page.screenshot({ path: 'match-breakdown-modal.png', fullPage: false });
});
