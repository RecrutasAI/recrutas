import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const EXEC = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1169/chrome-linux/headless_shell';
const EXT = '/home/akabas7/recrutas/extension/dist/chrome';
const OUT = '/home/akabas7/recrutas/extension/screenshots';
const JOB = 'https://job-boards.greenhouse.io/adyen/jobs/8002490';
const contentCss = readFileSync(EXT + '/content.css', 'utf8');

const DEMO = {
  first_name: 'Alex',
  last_name: 'Morgan',
  email: 'alex.morgan@gmail.com',
  phone: '+1 (415) 555-0142',
};

const FLOAT_BTN = `
  (function(){
    if (document.getElementById('recrutas-fill-btn')) return;
    const b = document.createElement('button');
    b.id = 'recrutas-fill-btn';
    b.className = 'recrutas-fill-btn';
    b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Fill with Recrutas';
    document.body.appendChild(b);
  })();`;

const browser = await chromium.launch({ executablePath: EXEC });

// ─────────────────────────────────────── 1. POPUP (signed-in) ────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 320, height: 520 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    window.chrome = {
      runtime: {
        id: 'demo',
        sendMessage: async (msg) => {
          if (msg.type === 'GET_STATUS') return {
            authenticated: true, userName: 'Alex Morgan', userEmail: 'alex.morgan@gmail.com',
            fillStats: { totalFills: 12, totalFields: 187 },
          };
          if (msg.type === 'GET_PROFILE') return {
            success: true,
            profile: {
              resumeUrl: 'https://x', skills: ['React','TypeScript','Node.js','Python','AWS','GraphQL'],
              experience: '5y', location: 'San Francisco', workType: 'remote',
              salaryMin: 120000, salaryMax: 160000,
            },
          };
          return {};
        },
      },
      storage: { local: { get: async () => ({}) } },
    };
  });
  const page = await ctx.newPage();
  await page.goto('file://' + EXT + '/popup.html', { waitUntil: 'load' });
  await page.waitForSelector('#view-profile:not(.hidden)', { timeout: 8000 });
  await page.waitForTimeout(600);
  const h = await page.evaluate(() => document.querySelector('.container').getBoundingClientRect().height);
  await page.setViewportSize({ width: 320, height: Math.ceil(h) });
  await page.screenshot({ path: OUT + '/1-popup.png' });
  console.log('✓ 1-popup.png  (container height', Math.ceil(h) + ')');
  await ctx.close();
}

// ─────────────────────── shared: open job page & reach the form ───────────────
async function openJobPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(JOB, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('#first_name', { timeout: 30000 });
  await page.addStyleTag({ content: contentCss });
  // This page ignores el.scrollIntoView(); window.scrollTo works (clamps to max).
  await page.evaluate(() => {
    const el = document.getElementById('first_name');
    const target = el.getBoundingClientRect().top + window.scrollY - 150;
    window.scrollTo(0, target);
  });
  await page.waitForTimeout(600);
  return { ctx, page };
}

// ─────────────────────────────────────── 2. FLOATING BUTTON ──────────────────
{
  const { ctx, page } = await openJobPage();
  await page.evaluate(FLOAT_BTN);
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + '/2-floating-button.png' });
  console.log('✓ 2-floating-button.png');
  await ctx.close();
}

// ─────────────────────────────────────── 3. MID-FILL ─────────────────────────
{
  const { ctx, page } = await openJobPage();
  await page.evaluate(FLOAT_BTN);
  await page.evaluate((demo) => {
    function setNativeValue(el, value) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
        : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter ? setter.call(el, value) : (el.value = value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    let n = 0;
    for (const [id, val] of Object.entries(demo)) {
      const el = document.getElementById(id);
      if (!el) continue;
      setNativeValue(el, val);
      el.style.transition = 'background-color 0.3s ease';
      el.style.backgroundColor = '#d1fae5'; // emerald highlight from content.js
      n++;
    }
    // success banner — same markup/classes as content.js showBanner()
    const banner = document.createElement('div');
    banner.id = 'recrutas-banner';
    banner.className = 'recrutas-banner recrutas-banner--success';
    banner.textContent = `Filled ${n} fields — review before submitting`;
    document.body.appendChild(banner);
  }, DEMO);
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/3-mid-fill.png' });
  console.log('✓ 3-mid-fill.png');
  await ctx.close();
}

await browser.close();
console.log('done');
