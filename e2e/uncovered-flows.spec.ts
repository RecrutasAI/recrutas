/**
 * Uncovered Flows — E2E Tests
 *
 * Covers the gaps left by comprehensive-mvp.spec.ts:
 *  1. Exam end-to-end (create job → auto-generate exam → apply → fetch questions → submit → score)
 *  2. Chat end-to-end (create room → send message → candidate reads → replies → TO reads reply)
 *  3. Mobile viewports (landing, auth, dashboards at 375px)
 *  4. Real resume upload (valid PDF with proper magic bytes, full Supabase round-trip)
 *
 * Credentials:
 *   Candidate:     E2E_CANDIDATE_EMAIL / E2E_CANDIDATE_PASSWORD (env)
 *   Talent Owner:  E2E_TALENT_EMAIL / E2E_TALENT_PASSWORD (env)
 */

import { test, expect, type Page } from '@playwright/test';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loginAs(page: Page, email: string, password: string) {
  await page.goto('/auth');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /sign in|login/i }).click();
}

async function getAuthToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.includes('supabase') || key.includes('auth')) {
        try {
          const val = JSON.parse(localStorage.getItem(key) || '{}');
          const token =
            val?.access_token ||
            val?.currentSession?.access_token ||
            val?.session?.access_token;
          if (token) {return token;}
        } catch {}
      }
    }
    return '';
  });
}

async function apiGet(page: Page, path: string) {
  const token = await getAuthToken(page);
  return page.evaluate(
    async ([p, t]) => {
      const res = await fetch(p, {
        headers: t ? { Authorization: `Bearer ${t}` } : {},
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [path, token] as [string, string]
  );
}

async function apiPost(page: Page, path: string, payload: unknown) {
  const token = await getAuthToken(page);
  return page.evaluate(
    async ([p, t, data]) => {
      const res = await fetch(p as string, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(t ? { Authorization: `Bearer ${t as string}` } : {}),
        },
        body: JSON.stringify(data),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [path, token, payload] as [string, string, unknown]
  );
}

// Minimal valid PDF (passes magic-byte check: starts with %PDF)
function fakePdfBytes(): number[] {
  return [
    0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, // %PDF-1.4\n
    0x31, 0x20, 0x30, 0x20, 0x6F, 0x62, 0x6A, 0x0A,         // 1 0 obj\n
    0x3C, 0x3C, 0x2F, 0x54, 0x79, 0x70, 0x65, 0x2F,         // <</Type/
    0x43, 0x61, 0x74, 0x61, 0x6C, 0x6F, 0x67, 0x3E,         // Catalog>
    0x3E, 0x0A, 0x65, 0x6E, 0x64, 0x6F, 0x62, 0x6A,         // >\nendobj
    0x0A, 0x25, 0x25, 0x45, 0x4F, 0x46,                     // \n%%EOF
  ];
}

// ─── 1. Exam End-to-End Flow ──────────────────────────────────────────────────

test.describe('1. Exam End-to-End Flow', () => {
  // Shared state across tests in this describe block
  let examJobId: number;
  let examQuestions: any[];

  test.setTimeout(60000); // exam generation is async, give it time

  test('talent owner creates job with hasExam:true', async ({ page }) => {
    await loginAs(page, (process.env.E2E_TALENT_EMAIL ?? ''), (process.env.E2E_TALENT_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/talent-dashboard/, { timeout: 20000 });

    const title = `Exam Test Job ${Date.now()}`;
    const { status, body } = await apiPost(page, '/api/jobs', {
      title,
      company: 'E2E Exam Corp',
      description:
        'We need a React and TypeScript engineer for our frontend team. Must know PostgreSQL and REST APIs.',
      requirements: ['3+ years React experience', 'TypeScript proficiency'],
      skills: ['React', 'TypeScript', 'PostgreSQL'],
      location: 'Remote',
      workType: 'remote',
      salaryMin: 90000,
      salaryMax: 130000,
      hasExam: true,
      examPassingScore: 60,
      status: 'active',
    });

    expect([200, 201]).toContain(status);
    expect(body?.id).toBeDefined();
    examJobId = body.id;
    console.log(`Created exam job ID: ${examJobId}`);
  });

  test('exam is auto-generated within 30s of job creation', async ({ page }) => {
    if (!examJobId) {return test.skip();}
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    // Poll until the exam is in the DB.
    // Route returns 404 while exam hasn't been generated yet, then:
    //   403 = exam exists but candidate hasn't applied yet
    //   200 = exam exists and candidate has applied
    // Both 403 and 200 confirm generation succeeded.
    let examGenerated = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      const { status } = await apiGet(page, `/api/jobs/${examJobId}/exam`);
      if (status === 200 || status === 403) {
        examGenerated = true;
        break;
      }
    }

    expect(examGenerated).toBe(true);
    console.log(`Exam confirmed generated for job ${examJobId}`);
  });

  test('candidate can apply to job with exam', async ({ page }) => {
    if (!examJobId) {return test.skip();}
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    const { status } = await apiPost(page, `/api/candidate/apply/${examJobId}`, {});
    // 200/201 = applied, 409 = already applied (both ok)
    expect([200, 201, 409]).toContain(status);
  });

  test('candidate fetches exam questions (no correct answers exposed)', async ({ page }) => {
    if (!examJobId) {return test.skip();}
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    const { status, body } = await apiGet(page, `/api/jobs/${examJobId}/exam`);
    expect(status).toBe(200);
    expect(body.questions).toBeDefined();
    expect(body.questions.length).toBeGreaterThan(0);

    // correctAnswer must NOT be exposed to candidates (security check)
    for (const q of body.questions) {
      expect(q.correctAnswer).toBeUndefined();
    }
    examQuestions = body.questions;
  });

  test('candidate submits exam answers and receives a score', async ({ page }) => {
    if (!examJobId || !examQuestions?.length) {return test.skip();}
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    // Build answers: for multiple-choice pick option index 2 (Advanced);
    // for short-answer provide a text response
    const answers: Record<string, number | string> = {};
    for (const q of examQuestions) {
      if (q.type === 'multiple-choice') {
        answers[q.id] = 2; // "Advanced (4-5 years)"
      } else {
        answers[q.id] = 'I have extensive experience with this and have delivered production results.';
      }
    }

    const { status, body } = await apiPost(page, `/api/jobs/${examJobId}/exam/submit`, { answers });
    expect([200, 201]).toContain(status);
    expect(typeof body?.score).toBe('number');
    expect(body.score).toBeGreaterThanOrEqual(0);
    expect(body.score).toBeLessThanOrEqual(100);
    console.log(`Exam score: ${body.score}/100`);
  });

  test('talent owner can see exam score in applicants list', async ({ page }) => {
    if (!examJobId) {return test.skip();}
    await loginAs(page, (process.env.E2E_TALENT_EMAIL ?? ''), (process.env.E2E_TALENT_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/talent-dashboard/, { timeout: 20000 });

    const { status, body } = await apiGet(page, `/api/jobs/${examJobId}/applicants`);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    // At least one applicant with a score
    const withScore = body.filter((a: any) => a.examScore !== null && a.examScore !== undefined);
    expect(withScore.length).toBeGreaterThan(0);
    console.log(`Applicant exam score via TO: ${withScore[0].examScore}`);
  });
});

// ─── 2. Chat End-to-End Flow ──────────────────────────────────────────────────

test.describe('2. Chat End-to-End Flow', () => {
  let chatRoomId: number;
  let chatJobId: number;
  let candidateUserId: string;

  test.setTimeout(60000);

  test('get candidate user ID from profile', async ({ page }) => {
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    // Get user ID from the Supabase auth session
    candidateUserId = await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.includes('supabase') || key.includes('auth')) {
          try {
            const val = JSON.parse(localStorage.getItem(key) || '{}');
            const uid =
              val?.user?.id ||
              val?.currentSession?.user?.id ||
              val?.session?.user?.id;
            if (uid) {return uid;}
          } catch {}
        }
      }
      return '';
    });
    expect(candidateUserId).toMatch(/^[0-9a-f-]{36}$/i);
    console.log(`Candidate UUID: ${candidateUserId}`);
  });

  test('talent owner gets a job to associate with chat', async ({ page }) => {
    await loginAs(page, (process.env.E2E_TALENT_EMAIL ?? ''), (process.env.E2E_TALENT_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/talent-dashboard/, { timeout: 20000 });

    const { status, body } = await apiGet(page, '/api/talent-owner/jobs');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    chatJobId = body[0].id;
    console.log(`Using job ID for chat: ${chatJobId}`);
  });

  test('talent owner creates chat room for candidate', async ({ page }) => {
    if (!chatJobId || !candidateUserId) {return test.skip();}
    await loginAs(page, (process.env.E2E_TALENT_EMAIL ?? ''), (process.env.E2E_TALENT_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/talent-dashboard/, { timeout: 20000 });
    // Allow session to fully stabilize before making auth-sensitive API calls
    await page.waitForTimeout(1500);

    const { status, body } = await apiPost(page, '/api/chat/rooms/create', {
      jobId: chatJobId,
      candidateId: candidateUserId,
    });
    // 200/201 = created/existing room returned
    expect([200, 201]).toContain(status);
    expect(body?.id).toBeDefined();
    chatRoomId = body.id;
    console.log(`Chat room ID: ${chatRoomId}`);
  });

  test('talent owner sends first message', async ({ page }) => {
    if (!chatRoomId) {return test.skip();}
    await loginAs(page, (process.env.E2E_TALENT_EMAIL ?? ''), (process.env.E2E_TALENT_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/talent-dashboard/, { timeout: 20000 });

    const { status, body } = await apiPost(
      page,
      `/api/chat/rooms/${chatRoomId}/messages`,
      { message: 'Hi! We reviewed your application and would love to chat. Are you available this week?' }
    );
    expect([200, 201]).toContain(status);
    expect(body?.id).toBeDefined();
    expect(body?.message).toBeDefined();
    // HTML should be stripped (XSS prevention)
    expect(body.message).not.toContain('<');
  });

  test('candidate sees the chat room in their rooms list', async ({ page }) => {
    if (!chatRoomId) {return test.skip();}
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    const { status, body } = await apiGet(page, '/api/chat/rooms');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((r: any) => r.id === chatRoomId);
    expect(found).toBeDefined();
  });

  test('candidate reads messages and sees talent owner message', async ({ page }) => {
    if (!chatRoomId) {return test.skip();}
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    const { status, body } = await apiGet(page, `/api/chat/rooms/${chatRoomId}/messages`);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    const toMsg = body.find((m: any) =>
      m.message.toLowerCase().includes('application') ||
      m.message.toLowerCase().includes('available')
    );
    expect(toMsg).toBeDefined();
  });

  test('candidate replies in chat', async ({ page }) => {
    if (!chatRoomId) {return test.skip();}
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    const { status, body } = await apiPost(
      page,
      `/api/chat/rooms/${chatRoomId}/messages`,
      { message: 'Yes, I am available Tuesday or Wednesday afternoon.' }
    );
    expect([200, 201]).toContain(status);
    expect(body?.message).toBeDefined();
  });

  test('talent owner sees candidate reply', async ({ page }) => {
    if (!chatRoomId) {return test.skip();}
    await loginAs(page, (process.env.E2E_TALENT_EMAIL ?? ''), (process.env.E2E_TALENT_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/talent-dashboard/, { timeout: 20000 });

    const { status, body } = await apiGet(page, `/api/chat/rooms/${chatRoomId}/messages`);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    // Should now have at least 2 messages (TO message + candidate reply)
    expect(body.length).toBeGreaterThanOrEqual(2);
    const candidateReply = body.find((m: any) =>
      m.message.toLowerCase().includes('tuesday') || m.message.toLowerCase().includes('available')
    );
    expect(candidateReply).toBeDefined();
  });

  test('chat message sanitizes HTML (XSS prevention)', async ({ page }) => {
    if (!chatRoomId) {return test.skip();}
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    const { status, body } = await apiPost(
      page,
      `/api/chat/rooms/${chatRoomId}/messages`,
      { message: '<script>alert("xss")</script>Hello there!' }
    );
    expect([200, 201]).toContain(status);
    // HTML tags must be stripped (XSS prevention)
    expect(body?.message).not.toContain('<script>');
    expect(body?.message).not.toContain('</script>');
    // Non-HTML content should survive
    expect(body?.message).toContain('Hello there');
  });

  test('chat enforces message length limit (>5000 chars rejected)', async ({ page }) => {
    if (!chatRoomId) {return test.skip();}
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    const tooLong = 'a'.repeat(5001);
    const { status } = await apiPost(
      page,
      `/api/chat/rooms/${chatRoomId}/messages`,
      { message: tooLong }
    );
    expect(status).toBe(400);
  });
});

// ─── 3. Mobile Viewport Tests ─────────────────────────────────────────────────

test.describe('3. Mobile Viewport (375×812 — iPhone SE)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('landing page renders on mobile', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
    const text = await page.textContent('body');
    expect(text!.length).toBeGreaterThan(200);
    // No horizontal overflow (page fits within 375px)
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(400); // small tolerance for scrollbars
  });

  test('auth page renders and form is usable on mobile', async ({ page }) => {
    await page.goto('/auth');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in|login/i })).toBeVisible();
  });

  test('pricing page renders on mobile', async ({ page }) => {
    await page.goto('/pricing');
    await expect(page.locator('body')).toBeVisible();
    const text = await page.textContent('body');
    expect(text!.length).toBeGreaterThan(100);
  });

  test('candidate dashboard renders on mobile', async ({ page }) => {
    await page.goto('/auth');
    await page.locator('input[type="email"]').fill((process.env.E2E_CANDIDATE_EMAIL ?? ''));
    await page.locator('input[type="password"]').fill((process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await page.getByRole('button', { name: /sign in|login/i }).click();
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });
    await page.waitForTimeout(2000);
    await expect(page.locator('body')).toBeVisible();
    const text = await page.textContent('body');
    expect(text!.length).toBeGreaterThan(200);
  });

  test('talent owner dashboard renders on mobile', async ({ page }) => {
    await page.goto('/auth');
    await page.locator('input[type="email"]').fill((process.env.E2E_TALENT_EMAIL ?? ''));
    await page.locator('input[type="password"]').fill((process.env.E2E_TALENT_PASSWORD ?? ''));
    await page.getByRole('button', { name: /sign in|login/i }).click();
    await expect(page).toHaveURL(/\/talent-dashboard/, { timeout: 20000 });
    await page.waitForTimeout(2000);
    await expect(page.locator('body')).toBeVisible();
    const text = await page.textContent('body');
    expect(text!.length).toBeGreaterThan(200);
  });
});

// ─── 4. Real Resume Upload (Supabase Storage Round-trip) ─────────────────────

test.describe('4. Resume Upload — Supabase Storage Round-trip', () => {
  test.setTimeout(45000);

  test('valid PDF uploads successfully and returns resumeUrl', async ({ page }) => {
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    const token = await getAuthToken(page);
    const bytes = fakePdfBytes();

    const result = await page.evaluate(
      async ([authToken, pdfBytes]) => {
        const uint8 = new Uint8Array(pdfBytes as number[]);
        const blob = new Blob([uint8], { type: 'application/pdf' });
        const formData = new FormData();
        formData.append('resume', blob, 'candidate-resume.pdf');

        const res = await fetch('/api/candidate/resume', {
          method: 'POST',
          body: formData,
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        });
        const data = await res.json().catch(() => null);
        return { status: res.status, data };
      },
      [token, bytes] as [string, number[]]
    );

    // 200 = success with Supabase round-trip
    expect(result.status).toBe(200);
    expect(result.data?.resumeUrl).toBeDefined();
    expect(typeof result.data.resumeUrl).toBe('string');
    expect(result.data.resumeUrl.length).toBeGreaterThan(10);
    console.log(`Resume uploaded to: ${result.data.resumeUrl}`);
  });

  test('resume URL is accessible after upload (profile updated)', async ({ page }) => {
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    const { status, body } = await apiGet(page, '/api/candidate/profile');
    expect(status).toBe(200);
    // After upload, resumeUrl should be set
    expect(body?.resumeUrl).toBeDefined();
    expect(body.resumeUrl.length).toBeGreaterThan(10);
  });

  test('wrong file type (txt) is rejected with 400, not 500', async ({ page }) => {
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    const token = await getAuthToken(page);
    const result = await page.evaluate(async (authToken) => {
      const blob = new Blob(['plain text resume'], { type: 'text/plain' });
      const formData = new FormData();
      formData.append('resume', blob, 'resume.txt');
      const res = await fetch('/api/candidate/resume', {
        method: 'POST',
        body: formData,
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      return { status: res.status };
    }, token);

    // Must be a client error (400), not a server crash (500)
    expect(result.status).toBe(400);
  });

  test('file exceeding 4MB is rejected', async ({ page }) => {
    await loginAs(page, (process.env.E2E_CANDIDATE_EMAIL ?? ''), (process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 20000 });

    const token = await getAuthToken(page);
    const result = await page.evaluate(async (authToken) => {
      // 5MB of PDF-looking bytes (starts with %PDF magic, rest is junk)
      const bytes = new Uint8Array(5 * 1024 * 1024);
      bytes[0] = 0x25; bytes[1] = 0x50; bytes[2] = 0x44; bytes[3] = 0x46; // %PDF
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const formData = new FormData();
      formData.append('resume', blob, 'huge-resume.pdf');
      const res = await fetch('/api/candidate/resume', {
        method: 'POST',
        body: formData,
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      return { status: res.status };
    }, token);

    // Multer rejects oversized files — should be 400 or 413, never 500
    expect([400, 413]).toContain(result.status);
  });

  test('unauthenticated resume upload returns 401', async ({ request }) => {
    const res = await request.post('http://localhost:5000/api/candidate/resume');
    expect([401, 403]).toContain(res.status());
  });
});
