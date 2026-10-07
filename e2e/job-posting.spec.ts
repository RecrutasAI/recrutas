/**
 * E2E Tests: Job Posting Flow (Employer / Talent Owner)
 *
 * Tests the critical path for talent owners managing job postings
 * via the talent dashboard (the app uses /talent-dashboard with tabs,
 * not standalone /jobs/new or /my-jobs routes).
 */

import { test, expect } from '@playwright/test';

const EMPLOYER_EMAIL = (process.env.E2E_TALENT_EMAIL ?? '');
const EMPLOYER_PASSWORD = (process.env.E2E_TALENT_PASSWORD ?? '');

test.describe('Job Posting (Employer)', () => {
  async function goToJobsTab(page: any) {
    // The talent dashboard defaults to Overview; navigate to Jobs tab
    await page.getByRole('button', { name: /^jobs$/i }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  test.beforeEach(async ({ page }) => {
    await page.goto('/auth');
    await page.locator('input[type="email"]').fill(EMPLOYER_EMAIL);
    await page.locator('input[type="password"]').fill(EMPLOYER_PASSWORD);
    await page.getByRole('button', { name: /sign in|login/i }).click();

    await expect(page).toHaveURL(/\/talent-dashboard/, { timeout: 20000 });
  });

  test('should display the Jobs tab with job listings', async ({ page }) => {
    await goToJobsTab(page);
    // Jobs tab should be visible with "Job Postings" heading or "Post New Job" button
    const jobsContent = page.getByText(/job posting|manage your job|post new job/i);
    await expect(jobsContent.first()).toBeVisible({ timeout: 10000 });
  });

  test('should have a Post New Job button', async ({ page }) => {
    await goToJobsTab(page);
    const postButton = page.getByRole('button', { name: /post new job/i })
      .or(page.getByText('Post New Job').first());
    await expect(postButton).toBeVisible({ timeout: 8000 });
  });

  test('should open job creation dialog when Post New Job is clicked', async ({ page }) => {
    await goToJobsTab(page);
    const postButton = page.getByRole('button', { name: /post new job/i }).first();
    await postButton.click({ timeout: 8000 });

    // A dialog or form should appear
    const dialog = page.locator('[role="dialog"]');
    const formTitle = page.getByText(/create.*job|new job posting|job title/i);
    await expect(dialog.or(formTitle).first()).toBeVisible({ timeout: 5000 });
  });

  test('should show Candidates tab', async ({ page }) => {
    const candidatesTab = page.getByRole('tab', { name: /candidate/i })
      .or(page.getByText('Candidates').first());
    await candidatesTab.click({ timeout: 5000 });

    const candidatesContent = page.getByText(/select a job|view applicant|no candidate/i);
    await expect(candidatesContent.first()).toBeVisible({ timeout: 8000 });
  });

  test('should show Analytics tab', async ({ page }) => {
    const analyticsTab = page.getByRole('tab', { name: /analytic/i })
      .or(page.getByText('Analytics').first());
    await analyticsTab.click({ timeout: 5000 });

    const analyticsContent = page.getByText(/analytics|job performance|application trend/i);
    await expect(analyticsContent.first()).toBeVisible({ timeout: 8000 });
  });
});
