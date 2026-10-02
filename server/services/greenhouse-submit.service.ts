/**
 * Greenhouse Job Board submission via embed form.
 *
 * Flow:
 *   1. Fetch job questions from the public Boards API (GET, no auth)
 *   2. AI generates answers for all screening questions
 *   3. Playwright loads the Greenhouse embed form, fills fields, uploads resume, submits
 *
 * The Boards API POST endpoint requires an API key we don't have,
 * so we automate the public embed form instead.
 */

import { chromium, type Page, type Browser } from 'rebrowser-playwright';
import { callAI } from '../lib/ai-client';
import { getCompanyContext } from '../lib/company-context';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CandidateSubmission {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  githubUrl?: string;
  personalWebsite?: string;
  resumeUrl: string;
  resumeText?: string;
  location?: string;
  workAuthorized?: boolean;
  needsSponsorship?: boolean;
  skills?: string[];
  experience?: string;
  experienceLevel?: string;
  summary?: string;
}

export interface GreenhouseSubmitResult {
  success: boolean;
  applicationId?: number;
  error?: string;
  questionsAnswered?: number;
  questionsSkipped?: number;
  verificationRequired?: boolean;
  verificationEmail?: string;
}

/** Callback to retrieve a verification code from the candidate (e.g., via WebSocket prompt) */
export type VerificationCodeCallback = (email: string) => Promise<string | null>;

interface GreenhouseQuestion {
  label: string;
  fields: {
    name: string;
    type: string;
    required: boolean;
    values?: { label: string; value: number }[];
  }[];
}

// ==========================================
// URL PARSING
// ==========================================

export function parseGreenhouseUrl(url: string): { boardToken: string; jobId: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('greenhouse.io')) {
      const match = parsed.pathname.match(/\/([^/]+)\/jobs\/(\d+)/);
      if (match) {
        return { boardToken: match[1], jobId: match[2] };
      }
    }
  } catch {
    // ignore invalid URLs
  }
  return null;
}

// ==========================================
// FETCH JOB DATA
// ==========================================

async function fetchJobData(boardToken: string, jobId: string): Promise<{
  title: string;
  content: string;
  questions: GreenhouseQuestion[];
}> {
  try {
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs/${jobId}?questions=true`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Recrutas/1.0)' } }
    );
    if (!res.ok) return { title: '', content: '', questions: [] };
    const data = await res.json();
    return {
      title: data.title || '',
      content: data.content || '',
      questions: data.questions || [],
    };
  } catch {
    return { title: '', content: '', questions: [] };
  }
}

// ==========================================
// AI QUESTION ANSWERING
// ==========================================

export async function aiAnswerQuestions(
  questions: GreenhouseQuestion[],
  candidate: CandidateSubmission,
  jobTitle: string,
  jobDescription: string,
  companyName: string,
  companyContext?: string,
): Promise<Record<string, string | number>> {
  const questionItems: Array<{
    fieldName: string;
    label: string;
    type: string;
    required: boolean;
    options?: { label: string; value: number }[];
  }> = [];

  for (const q of questions) {
    for (const field of q.fields) {
      if (!field.name.startsWith('question_')) continue;
      questionItems.push({
        fieldName: field.name,
        label: q.label,
        type: field.type,
        required: field.required,
        options: field.values?.length ? field.values : undefined,
      });
    }
  }

  if (questionItems.length === 0) return {};

  const systemPrompt = `You are an AI assistant helping a job candidate fill out a job application form.
You will receive the candidate's resume/profile, the job details, company background info, and a list of screening questions.

Your job: answer each question naturally and honestly using the candidate's real data.

Rules:
- For multi_value_single_select fields: return the numeric "value" of the best matching option.
- For multi_value_multi_select fields: return a comma-separated string of numeric "value"s to check. For acknowledgment/consent checkboxes, always return the value. For "how did you hear" questions, select "Other" or the most generic option.
- For input_text fields: write a concise, direct answer (1 sentence max).
- For textarea fields: write a professional answer (2-4 sentences).
- Use the candidate's actual information — never fabricate credentials, skills, or experience.
- For motivation questions ("why do you want to join", "why this company"): reference specific details about the company's mission, products, or values from the Company Background section. Connect those to the candidate's actual experience and interests. Be specific, not generic.
- For "what interests you about this role" questions: connect the role's responsibilities to the candidate's relevant experience.
- For location questions: use the candidate's actual location.
- For name/preferred name: use the candidate's first name.
- For "how did you hear" / source questions: say "Job board".
- For work authorization: default to selecting the "Yes" option if not specified otherwise.
- For sponsorship: default to selecting the "No" option if not specified otherwise.
- For acknowledgment/consent: select the affirmative option.
- For "was this application prepared by AI" questions: answer honestly — select "Yes".
- For pronouns: skip (return null).
- For salary/compensation: skip (return null).
- If you truly cannot answer from the available data, return null for that field.

Return JSON: { "answers": { "<fieldName>": <value or null>, ... } }`;

  const candidateContext = [
    `Name: ${candidate.firstName} ${candidate.lastName}`,
    `Email: ${candidate.email}`,
    candidate.phone ? `Phone: ${candidate.phone}` : null,
    candidate.location ? `Location: ${candidate.location}` : null,
    candidate.linkedinUrl ? `LinkedIn: ${candidate.linkedinUrl}` : null,
    candidate.githubUrl ? `GitHub: ${candidate.githubUrl}` : null,
    candidate.portfolioUrl ? `Portfolio: ${candidate.portfolioUrl}` : null,
    candidate.personalWebsite ? `Website: ${candidate.personalWebsite}` : null,
    candidate.workAuthorized !== undefined ? `Work authorized: ${candidate.workAuthorized}` : null,
    candidate.needsSponsorship !== undefined ? `Needs sponsorship: ${candidate.needsSponsorship}` : null,
    candidate.experienceLevel ? `Experience level: ${candidate.experienceLevel}` : null,
    candidate.skills?.length ? `Skills: ${candidate.skills.join(', ')}` : null,
    candidate.experience ? `Experience: ${candidate.experience}` : null,
    candidate.summary ? `Summary: ${candidate.summary}` : null,
  ].filter(Boolean).join('\n');

  const resumeSnippet = candidate.resumeText
    ? candidate.resumeText.slice(0, 3000)
    : '(resume text not available)';

  const cleanDescription = jobDescription.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);

  const companySection = companyContext
    ? `\n## Company Background\n${companyContext}`
    : '';

  const userPrompt = `## Candidate Profile
${candidateContext}

## Resume
${resumeSnippet}

## Job
Company: ${companyName}
Title: ${jobTitle}
Description: ${cleanDescription}
${companySection}

## Questions to Answer
${JSON.stringify(questionItems, null, 2)}`;

  try {
    const raw = await callAI(systemPrompt, userPrompt, {
      priority: 'high',
      estimatedTokens: 1500,
      temperature: 0.3,
      maxOutputTokens: 2000,
    });

    const parsed = JSON.parse(raw);
    const answers: Record<string, string | number> = {};

    for (const [fieldName, value] of Object.entries(parsed.answers || {})) {
      if (value !== null && value !== undefined && value !== '') {
        answers[fieldName] = value as string | number;
      }
    }

    return answers;
  } catch (err) {
    console.error('[greenhouse-submit] AI question answering failed:', (err as Error).message);
    return {};
  }
}

// ==========================================
// COVER LETTER GENERATION
// ==========================================

async function generateCoverLetter(
  candidate: CandidateSubmission,
  jobTitle: string,
  jobDescription: string,
  companyName: string,
  companyContext?: string,
): Promise<string | null> {
  const systemPrompt = `Write a concise cover letter (3-4 paragraphs, under 250 words) for a job application.
Use the candidate's actual experience from their resume. Be specific about the company and role.
Do not fabricate credentials. Write in first person. No salutation or sign-off, just the body text.
Do not use em dashes (—); recruiters read them as AI-written. Use commas or periods instead.`;

  const cleanDescription = jobDescription.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
  const resumeSnippet = candidate.resumeText?.slice(0, 2000) || '';

  const userPrompt = `Candidate: ${candidate.firstName} ${candidate.lastName}
Resume: ${resumeSnippet}
Company: ${companyName}
Role: ${jobTitle}
Description: ${cleanDescription}
${companyContext ? `Company background: ${companyContext}` : ''}`;

  try {
    return await callAI(systemPrompt, userPrompt, {
      priority: 'medium',
      estimatedTokens: 800,
      temperature: 0.4,
      maxOutputTokens: 500,
    });
  } catch (err) {
    console.warn('[greenhouse-submit] Cover letter generation failed:', (err as Error).message);
    return null;
  }
}

// ==========================================
// PLAYWRIGHT FORM SUBMISSION
// ==========================================

/**
 * Submit an application to a Greenhouse job via the embed form.
 *
 * 1. Fetches job questions via API
 * 2. AI answers questions
 * 3. Playwright fills + submits the embed form
 */
export async function submitToGreenhouse(
  boardToken: string,
  jobId: string,
  candidate: CandidateSubmission,
  onVerificationRequired?: VerificationCodeCallback,
): Promise<GreenhouseSubmitResult> {
  // Download resume to a temp file for Playwright file upload
  let resumeTmpPath: string | null = null;
  try {
    const resumeRes = await fetch(candidate.resumeUrl);
    if (!resumeRes.ok) {
      return { success: false, error: `Failed to fetch resume: HTTP ${resumeRes.status}` };
    }
    const resumeBuffer = Buffer.from(await resumeRes.arrayBuffer());

    // Validate: expired signed URLs return tiny HTML/JSON errors, not real documents
    const contentType = resumeRes.headers.get('content-type') || '';
    if (resumeBuffer.length < 500 && !contentType.includes('pdf')) {
      return { success: false, error: 'Resume URL may have expired: downloaded file is too small' };
    }

    const urlPath = candidate.resumeUrl.split('?')[0];
    const ext = path.extname(urlPath.split('/').pop() || '') || '.pdf';
    resumeTmpPath = path.join(os.tmpdir(), `resume-${Date.now()}${ext}`);
    fs.writeFileSync(resumeTmpPath, resumeBuffer);
  } catch (err) {
    return { success: false, error: `Failed to download resume: ${(err as Error).message}` };
  }

  // Fetch job data + questions via API
  const companyName = boardToken.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const jobData = await fetchJobData(boardToken, jobId);

  // Fetch company context for better AI answers (non-blocking — empty string on failure)
  let companyContext = '';
  try {
    companyContext = await getCompanyContext(companyName, boardToken);
  } catch (err) {
    console.warn('[greenhouse-submit] Company context fetch failed (continuing without):', (err as Error).message);
  }

  // AI-answer all custom questions
  const aiAnswers = await aiAnswerQuestions(
    jobData.questions,
    candidate,
    jobData.title,
    jobData.content,
    companyName,
    companyContext,
  );

  let questionsAnswered = 0;
  let questionsSkipped = 0;
  for (const q of jobData.questions) {
    for (const field of q.fields) {
      if (!field.name.startsWith('question_')) continue;
      if (aiAnswers[field.name] !== undefined) questionsAnswered++;
      else questionsSkipped++;
    }
  }

  console.log(`[greenhouse-submit] ${companyName} — ${jobData.title}: ${questionsAnswered} answered, ${questionsSkipped} skipped`);

  // Build the field→value map for form filling (standard + AI-answered)
  const fieldValues: Record<string, string> = {
    first_name: candidate.firstName,
    last_name: candidate.lastName,
    email: candidate.email,
  };
  if (candidate.phone) fieldValues.phone = candidate.phone;
  if (candidate.location) fieldValues.candidate_location = candidate.location;

  // Map AI answers into the field values
  for (const [fieldName, value] of Object.entries(aiAnswers)) {
    fieldValues[fieldName] = String(value);
  }

  // Use Playwright to fill and submit the embed form
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });

    // Stealth: hide automation signals from Greenhouse's bot detection
    await context.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
      if (!window.chrome) {
        window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
      }
    `);

    const page = await context.newPage();

    // Load the Greenhouse job page (Remix SPA — renders form with id-based fields)
    const jobPageUrl = `https://job-boards.greenhouse.io/${boardToken}/jobs/${jobId}`;
    console.log(`[greenhouse-submit] Loading: ${jobPageUrl}`);
    await page.goto(jobPageUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for the form to render
    await page.waitForSelector('#first_name, form, input[type="text"]', { timeout: 15000 });
    await page.waitForTimeout(2000);

    // Fill simple text fields
    for (const { sel, val } of [
      { sel: '#first_name', val: candidate.firstName },
      { sel: '#last_name', val: candidate.lastName },
      { sel: '#email', val: candidate.email },
    ]) {
      const el = await page.$(sel);
      if (el) { await el.click(); await el.fill(val); }
    }

    // Handle country dropdown (React Select) — use "United States" as default
    // since most Recrutas candidates are US-based; location field has city/state, not country
    await fillReactSelect(page, '#country', 'United States');

    // Handle location (React Select with autocomplete)
    if (candidate.location) {
      const city = candidate.location.split(',')[0].trim();
      await fillReactSelect(page, '#candidate-location', city);
    }

    // Handle phone with ITI widget
    if (candidate.phone) {
      await fillPhone(page, candidate.phone);
    }

    // Fill AI-answered question fields
    for (const [fieldName, value] of Object.entries(aiAnswers)) {
      const question = jobData.questions.find(q => q.fields.some(f => f.name === fieldName));
      const field = question?.fields.find(f => f.name === fieldName);

      if (field?.type === 'multi_value_multi_select' && field.values?.length) {
        // Checkboxes — each option has id="${fieldName}_${value}"
        // AI returns a numeric value ID (or comma-separated for multiple)
        const valueIds = String(value).split(',').map(v => v.trim());
        for (const vid of valueIds) {
          const checkboxId = `${fieldName}_${vid}`;
          // IDs contain [] which need escaping in CSS selectors
          const escapedId = checkboxId.replace(/([[\]])/g, '\\$1');
          const cb = await page.$(`#${escapedId}`);
          if (cb) {
            await cb.check();
            console.log(`[greenhouse-submit] Checked: ${checkboxId}`);
          }
        }
      } else if (field?.type === 'multi_value_single_select' && field.values?.length) {
        // React Select dropdown — find the label for the AI's numeric answer
        const numValue = Number(value);
        const optionLabel = field.values.find(v => v.value === numValue)?.label || String(value);
        await fillReactSelect(page, `#${fieldName}`, optionLabel);
      } else {
        // Text input or textarea
        const el = await page.$(`#${fieldName}`);
        if (el) { await el.click(); await el.fill(String(value)); }
      }
      await page.waitForTimeout(200);
    }

    // Fill URL fields (LinkedIn, GitHub, portfolio)
    if (candidate.linkedinUrl) {
      await tryFillByLabel(page, 'LinkedIn', candidate.linkedinUrl);
    }
    if (candidate.githubUrl) {
      await tryFillByLabel(page, 'GitHub', candidate.githubUrl);
    }
    if (candidate.portfolioUrl || candidate.personalWebsite) {
      await tryFillByLabel(page, 'Website', candidate.portfolioUrl || candidate.personalWebsite || '');
      await tryFillByLabel(page, 'Portfolio', candidate.portfolioUrl || candidate.personalWebsite || '');
    }

    // Fill cover letter if the form has one
    const coverLetterEl = await page.$('#cover_letter_text, textarea[name*="cover_letter"]');
    if (coverLetterEl && candidate.resumeText) {
      const coverLetter = await generateCoverLetter(candidate, jobData.title, jobData.content, companyName, companyContext);
      if (coverLetter) {
        await coverLetterEl.click();
        await coverLetterEl.fill(coverLetter);
        console.log('[greenhouse-submit] Cover letter filled');
      }
    }

    // Fill preferred name if present
    const preferredName = await page.$('#preferred_name');
    if (preferredName) {
      await preferredName.click();
      await preferredName.fill(candidate.firstName);
    }

    // Check GDPR/consent checkboxes (Greenhouse adds these for EU compliance)
    const gdprCheckboxes = await page.locator('input[type="checkbox"][name*="gdpr"], input[type="checkbox"][name*="consent"], input[type="checkbox"][name*="data_processing"]').all();
    for (const cb of gdprCheckboxes) {
      await cb.check().catch(() => {});
    }

    // Handle EEO demographic fields (Gender, Race, Veteran, Disability)
    // These are React Select dropdowns that aren't in the Boards API.
    // Default to "Decline to Self Identify" / "I don't wish to answer".
    const eeoFields = [
      { selector: '#demographic_gender', answer: 'Decline' },
      { selector: '#demographic_race', answer: 'Decline' },
      { selector: '#demographic_veteran', answer: 'not a' }, // "I am not a protected veteran"
      { selector: '#demographic_disability', answer: 'don\'t wish' }, // "I don't wish to answer"
    ];
    for (const { selector, answer } of eeoFields) {
      const el = await page.$(selector);
      if (el) {
        await fillReactSelect(page, selector, answer);
      }
    }

    // Handle any remaining unfilled required React Select dropdowns
    // (catches EEO fields with non-standard IDs)
    const allSelects = await page.$$('[class*="select__control"]');
    for (const selectControl of allSelects) {
      try {
        // Check if this select already has a value
        const hasValue = await selectControl.$('[class*="select__single-value"]');
        if (hasValue) continue; // Already filled

        // Check if it's inside a required field
        const container = await selectControl.evaluateHandle((el: any) => el.closest('[class*="required"], .field'));
        if (!container) continue;

        // Try to open and select "Decline" or first option
        await selectControl.click();
        await page.waitForTimeout(300);
        const declineOpt = await page.$('[class*="select__option"]:has-text("Decline"), [class*="select__option"]:has-text("don\'t wish"), [class*="select__option"]:has-text("not a")');
        if (declineOpt) {
          await declineOpt.click();
        } else {
          // Select the last option (usually "Decline" / "Prefer not to say")
          const opts = await page.$$('[class*="select__option"]');
          if (opts.length > 0) await opts[opts.length - 1].click();
        }
        await page.waitForTimeout(200);
      } catch { /* continue */ }
    }

    // Upload resume
    if (resumeTmpPath) {
      const fileInput = await page.$('input[type="file"]#resume')
        || await page.$('input[type="file"][name*="resume"]')
        || await page.$('input[type="file"]:first-of-type');
      if (fileInput) {
        await fileInput.setInputFiles(resumeTmpPath);
        console.log('[greenhouse-submit] Resume uploaded');
        await page.waitForTimeout(1500);
      }
    }

    // Click submit
    const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
    if (!submitBtn) {
      return { success: false, error: 'Submit button not found', questionsAnswered, questionsSkipped };
    }

    await submitBtn.click();
    console.log('[greenhouse-submit] Clicked submit');

    // Wait for navigation/confirmation (Greenhouse may redirect or show inline success)
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: 12000 }),
      page.waitForTimeout(12000),
    ]).catch(() => {});

    // Check for email verification code step (Greenhouse anti-bot measure)
    const bodyTextRaw = await page.textContent('body').catch(() => '') || '';
    const needsVerification = /verification code|verify your email|enter.*code/i.test(bodyTextRaw);

    if (needsVerification) {
      console.log('[greenhouse-submit] Email verification required for', candidate.email);

      if (!onVerificationRequired) {
        return {
          success: false,
          error: 'verification_required',
          verificationRequired: true,
          verificationEmail: candidate.email,
          questionsAnswered,
          questionsSkipped,
        };
      }

      const code = await onVerificationRequired(candidate.email);
      if (!code) {
        return {
          success: false,
          error: 'Verification code not provided',
          verificationRequired: true,
          verificationEmail: candidate.email,
          questionsAnswered,
          questionsSkipped,
        };
      }

      // Greenhouse uses individual char inputs: security-input-0 through security-input-N
      const firstSecInput = await page.$('#security-input-0');
      if (firstSecInput) {
        for (let i = 0; i < code.length; i++) {
          const secInput = await page.$(`#security-input-${i}`);
          if (secInput) {
            await secInput.click();
            await secInput.fill(code[i]);
            await page.waitForTimeout(100);
          }
        }
        console.log(`[greenhouse-submit] Entered ${code.length}-char verification code`);
      } else {
        // Fallback: single code input field
        const codeInput = await page.$('input[name*="code"], input[placeholder*="code" i]');
        if (codeInput) {
          await codeInput.fill(code);
        }
      }

      await page.waitForTimeout(500);
      const verifyBtn = await page.$('button[type="submit"]');
      if (verifyBtn) {
        await verifyBtn.click();
        await page.waitForTimeout(8000);
      }
    }

    // Check for success
    const bodyText = await page.textContent('body').catch(() => '') || '';
    const currentUrl = page.url();
    const isSuccess =
      /thank you|application.*received|successfully submitted|thanks for applying|we.*received/i.test(bodyText) ||
      /confirm|thank|success/i.test(currentUrl);

    if (isSuccess) {
      console.log('[greenhouse-submit] Application submitted successfully');
      return { success: true, questionsAnswered, questionsSkipped };
    }

    // Check for validation errors (filter out ITI phone country list noise)
    const errors = await page.locator('[class*="error"], [class*="invalid"], [role="alert"]').allTextContents().catch(() => []);
    const errorMsg = errors
      .filter(e => e.trim() && !e.includes('+') && e.length < 200)
      .join('; ')
      .slice(0, 300);
    if (errorMsg) {
      return { success: false, error: `Validation: ${errorMsg}`, questionsAnswered, questionsSkipped };
    }

    // URL changed away from form = likely submitted
    if (currentUrl !== jobPageUrl && !currentUrl.includes(jobId)) {
      return { success: true, questionsAnswered, questionsSkipped };
    }

    return { success: false, error: 'No confirmation detected after submit', questionsAnswered, questionsSkipped };

  } catch (err) {
    return { success: false, error: `Playwright error: ${(err as Error).message}`, questionsAnswered, questionsSkipped };
  } finally {
    if (browser) await browser.close().catch(() => { /* cleanup */ });
    if (resumeTmpPath) try { fs.unlinkSync(resumeTmpPath); } catch { /* cleanup */ }
  }
}

// ==========================================
// FORM FILLING HELPERS
// ==========================================

/**
 * Fill a React Select dropdown. Greenhouse Remix UI uses react-select for
 * country, location, and all multi_value_single_select question fields.
 *
 * Each react-select instance has a listbox with id="react-select-{fieldId}-listbox".
 * We scope option clicks to this listbox to avoid matching ITI phone country options.
 */
async function fillReactSelect(page: Page, selector: string, searchText: string): Promise<boolean> {
  try {
    const input = await page.$(selector);
    if (!input) return false;

    const fieldId = await input.getAttribute('id');
    await input.scrollIntoViewIfNeeded();
    await input.click();
    await page.waitForTimeout(300);

    // Clear and type search text
    await input.fill(searchText);
    await page.waitForTimeout(1000); // Wait for options to load (location uses API)

    // Scope to the specific react-select listbox to avoid matching ITI phone options
    const listboxSelector = `#react-select-${fieldId}-listbox .select__option`;
    const options = await page.locator(listboxSelector).all();

    for (const opt of options) {
      const text = await opt.textContent().catch(() => '');
      if (text?.toLowerCase().includes(searchText.toLowerCase())) {
        await opt.click();
        console.log(`[greenhouse-submit] React Select ${selector}: "${text?.trim()}"`);
        await page.waitForTimeout(300);
        return true;
      }
    }

    // If no exact match, click the first option
    if (options.length > 0) {
      const text = await options[0].textContent().catch(() => '');
      await options[0].click();
      console.log(`[greenhouse-submit] React Select ${selector}: first option "${text?.trim()}"`);
      await page.waitForTimeout(300);
      return true;
    }

    console.log(`[greenhouse-submit] React Select ${selector}: no options found for "${searchText}"`);
    return false;
  } catch (err) {
    console.log(`[greenhouse-submit] React Select ${selector} error:`, (err as Error).message);
    return false;
  }
}

/**
 * Fill the phone field (handles Greenhouse's intl-tel-input widget).
 * The ITI instance is stored directly on the input element as `input.iti`.
 * We use its API to set country + number programmatically.
 */
async function fillPhone(page: Page, phone: string): Promise<void> {
  try {
    const digits = phone.replace(/[^\d]/g, '').replace(/^1/, '');
    const fullNumber = '+1' + digits;

    const success = await page.evaluate((num) => {
      const input = document.getElementById('phone') as HTMLInputElement & { iti?: any };
      if (!input) return false;

      // ITI instance is at input.iti (Greenhouse bundles ITI v25+)
      if (input.iti && typeof input.iti.setCountry === 'function') {
        input.iti.setCountry('us');
        input.iti.setNumber(num);
        // Fire events so React picks up the change
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }

      // Fallback: set value directly
      input.value = num;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return false;
    }, fullNumber);

    if (success) {
      console.log('[greenhouse-submit] Phone set via ITI API:', fullNumber);
    } else {
      console.log('[greenhouse-submit] Phone set via fallback (no ITI instance)');
    }
  } catch {
    // ignore
  }
}

/**
 * Try to fill a field by its label text (for URL fields like LinkedIn, GitHub).
 */
async function tryFillByLabel(page: Page, labelText: string, value: string): Promise<void> {
  try {
    // Find label containing the text, then find the associated input
    const label = await page.$(`label:has-text("${labelText}")`);
    if (label) {
      const forId = await label.getAttribute('for');
      if (forId) {
        const input = await page.$(`#${forId}`);
        if (input) {
          await input.click();
          await input.fill(value);
          return;
        }
      }
    }
    // Fallback: try finding input near the label
    const input = await page.$(`input[placeholder*="${labelText}" i], input[id*="${labelText.toLowerCase()}" i]`);
    if (input) {
      await input.click();
      await input.fill(value);
    }
  } catch {
    // ignore
  }
}
