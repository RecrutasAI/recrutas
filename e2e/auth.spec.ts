/**
 * E2E Tests: Authentication Flow
 *
 * Tests critical authentication paths:
 * - Login with valid credentials
 * - Login with invalid credentials
 * - Logout
 * - Protected route access
 */

import { test, expect } from '@playwright/test';

const CANDIDATE_EMAIL = (process.env.E2E_CANDIDATE_EMAIL ?? '');
const CANDIDATE_PASSWORD = (process.env.E2E_CANDIDATE_PASSWORD ?? '');

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should display login page for unauthenticated users', async ({ page }) => {
    await page.goto('/auth');

    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in|login/i })).toBeVisible();
  });

  test('should show error for invalid credentials', async ({ page }) => {
    await page.goto('/auth');

    await page.locator('input[type="email"]').fill('invalid@test.com');
    await page.locator('input[type="password"]').fill('wrongpassword');
    await page.getByRole('button', { name: /sign in|login/i }).click();

    await expect(page.getByText(/invalid|incorrect|failed/i).first()).toBeVisible({ timeout: 10000 });
  });

  test('should redirect to dashboard after successful login', async ({ page }) => {
    await page.goto('/auth');

    await page.locator('input[type="email"]').fill(CANDIDATE_EMAIL);
    await page.locator('input[type="password"]').fill(CANDIDATE_PASSWORD);
    await page.getByRole('button', { name: /sign in|login/i }).click();

    await expect(page).toHaveURL(/\/(candidate-dashboard|talent-dashboard|role-selection)/, { timeout: 20000 });
  });

  test('should prevent access to protected routes when not authenticated', async ({ page }) => {
    // Navigate directly to a protected route while not logged in
    await page.goto('/candidate-dashboard');

    // RoleGuard should redirect unauthenticated users to /auth
    await expect(page).toHaveURL(/\/auth/, { timeout: 8000 });
  });

  test('should logout successfully', async ({ page }) => {
    await page.goto('/auth');
    await page.locator('input[type="email"]').fill(CANDIDATE_EMAIL);
    await page.locator('input[type="password"]').fill(CANDIDATE_PASSWORD);
    await page.getByRole('button', { name: /sign in|login/i }).click();

    await expect(page).toHaveURL(/\/(candidate-dashboard|talent-dashboard|role-selection)/, { timeout: 20000 });

    // Open the user avatar dropdown and click "Sign out"
    const avatarButton = page.locator('button.rounded-full').first();
    await avatarButton.click();

    // Click the "Sign out" menu item in the dropdown
    await page.getByRole('menuitem', { name: /sign out/i }).first().click({ timeout: 5000 });

    await expect(page).toHaveURL(/\/auth/, { timeout: 8000 });
  });
});
