import { test, expect } from '@playwright/test';

const CANDIDATE_EMAIL    = (process.env.E2E_CANDIDATE_EMAIL ?? '');
const CANDIDATE_PASSWORD = (process.env.E2E_CANDIDATE_PASSWORD ?? '');
const TALENT_EMAIL       = (process.env.E2E_TALENT_EMAIL ?? '');
const TALENT_PASSWORD    = (process.env.E2E_TALENT_PASSWORD ?? '');

async function login(page: any, email: string, password: string) {
  await page.goto('/auth', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="email"]', { timeout: 5000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url: URL) => !url.pathname.includes('/auth'), { timeout: 10000 });
}

test.describe('Chat — candidate', () => {
  test('navigates to /chat without crashing', async ({ page }) => {
    await login(page, CANDIDATE_EMAIL, CANDIDATE_PASSWORD);

    // Go directly to /chat
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });

    // Should NOT show a JS error screen — expect the messages page or "No conversations"
    const heading = page.locator('h1:has-text("Messages"), h2:has-text("Conversations"), p:has-text("No conversations")').first();
    await expect(heading).toBeVisible({ timeout: 8000 });
    console.log('  Candidate /chat: page rendered without crash');
  });

  test('chat rooms list renders (no .map crash)', async ({ page }) => {
    await login(page, CANDIDATE_EMAIL, CANDIDATE_PASSWORD);
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });

    // Wait for loading to finish — either rooms appear or empty state
    await page.waitForSelector(
      '[class*="space-y"] button, p:has-text("No conversations"), p:has-text("Start chatting")',
      { timeout: 8000 }
    );

    // No uncaught JS errors
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.waitForTimeout(1000);
    expect(errors.filter(e => !e.includes('ResizeObserver'))).toHaveLength(0);
    console.log('  Candidate chat rooms: no JS errors');
  });

  test('opening a chat room does not crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await login(page, CANDIDATE_EMAIL, CANDIDATE_PASSWORD);
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });

    // If there are chat rooms, click the first one
    const firstRoom = page.locator('[class*="space-y"] button').first();
    const hasRooms = await firstRoom.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasRooms) {
      await firstRoom.click();
      // Chat interface should render — look for message input
      await page.waitForSelector('input[placeholder="Type your message..."]', { timeout: 8000 });
      console.log('  Candidate: opened chat room, message input visible');

      // Wait a moment for messages to load
      await page.waitForTimeout(2000);
      expect(errors.filter(e => !e.includes('ResizeObserver'))).toHaveLength(0);
      console.log('  Candidate: no JS errors after opening chat room');
    } else {
      console.log('  Candidate: no chat rooms available — skipping room open test');
      test.skip();
    }
  });
});

test.describe('Chat — talent (recruiter)', () => {
  test('navigates to /chat without crashing', async ({ page }) => {
    await login(page, TALENT_EMAIL, TALENT_PASSWORD);

    await page.goto('/chat', { waitUntil: 'domcontentloaded' });

    const heading = page.locator('h1:has-text("Messages"), h2:has-text("Conversations"), p:has-text("No conversations")').first();
    await expect(heading).toBeVisible({ timeout: 8000 });
    console.log('  Talent /chat: page rendered without crash');
  });

  test('chat rooms list renders (no .map crash)', async ({ page }) => {
    await login(page, TALENT_EMAIL, TALENT_PASSWORD);
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector(
      '[class*="space-y"] button, p:has-text("No conversations"), p:has-text("Start chatting")',
      { timeout: 8000 }
    );

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.waitForTimeout(1000);
    expect(errors.filter(e => !e.includes('ResizeObserver'))).toHaveLength(0);
    console.log('  Talent chat rooms: no JS errors');
  });

  test('opening a chat room does not crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await login(page, TALENT_EMAIL, TALENT_PASSWORD);
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });

    const firstRoom = page.locator('[class*="space-y"] button').first();
    const hasRooms = await firstRoom.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasRooms) {
      await firstRoom.click();
      await page.waitForSelector('input[placeholder="Type your message..."]', { timeout: 8000 });
      console.log('  Talent: opened chat room, message input visible');

      await page.waitForTimeout(2000);
      expect(errors.filter(e => !e.includes('ResizeObserver'))).toHaveLength(0);
      console.log('  Talent: no JS errors after opening chat room');
    } else {
      console.log('  Talent: no chat rooms available — skipping room open test');
      test.skip();
    }
  });

  test('session redirect race — /chat does not bounce to /auth', async ({ page }) => {
    // This test specifically validates the fix for the useSession() race condition
    // where authenticated users were being redirected to /auth on mount.
    await login(page, TALENT_EMAIL, TALENT_PASSWORD);

    const redirectedToAuth = { happened: false };
    page.on('request', (req) => {
      if (req.url().includes('/auth') && req.isNavigationRequest()) {
        redirectedToAuth.happened = true;
      }
    });

    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000); // wait longer than the 500ms redirect timer

    expect(redirectedToAuth.happened, 'Was unexpectedly redirected to /auth').toBe(false);
    console.log('  Session race condition: no spurious redirect to /auth');
  });
});
