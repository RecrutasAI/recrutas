// Autofill benchmark: load the extension into a real Firefox or Chrome, open
// live application forms, click "Fill with Recrutas", and score what got filled.
//
//   node fill-bench.mjs firefox urls.txt > ff.json
//   node fill-bench.mjs chrome  urls.txt > ch.json
//
// SAFETY: never submits. It reaches each form by navigating to its URL (never by
// clicking the page's own buttons) and the only element it clicks is the
// extension's own #recrutas-fill-btn.
//
// Env: BENCH_HOME (dir with session.json, firefox/, geckodriver, chrome-cft/,
// chrome-unpacked/, bench-firefox.xpi). session.json = a Supabase session for
// the test candidate, injected into www.recrutas.ai so the bridge hands it to
// the extension.
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import chrome from 'selenium-webdriver/chrome.js';
import { readFileSync, readdirSync } from 'fs';

const [, , BROWSER = 'firefox', URLS_FILE = 'bench-urls.txt'] = process.argv;
const HOME = process.env.BENCH_HOME || `${process.env.HOME}/ext-e2e`;
const LS_KEY = 'sb-fgdxsvlamtinkepfodfj-auth-token';
const session = JSON.parse(readFileSync(`${HOME}/session.json`, 'utf8'));
const urls = readFileSync(URLS_FILE, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const err = (...a) => console.error(...a);

async function build() {
  if (BROWSER === 'chrome') {
    const ver = readdirSync(`${HOME}/chrome-cft/chrome`).find(n => n.startsWith('linux-'));
    const o = new chrome.Options();
    o.setChromeBinaryPath(`${HOME}/chrome-cft/chrome/${ver}/chrome-linux64/chrome`);
    o.addArguments('--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1366,2000',
      `--load-extension=${HOME}/chrome-unpacked`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch');
    const svc = new chrome.ServiceBuilder(`${HOME}/chrome-cft/chromedriver/${ver}/chromedriver-linux64/chromedriver`);
    return new Builder().forBrowser('chrome').setChromeOptions(o).setChromeService(svc).build();
  }
  const o = new firefox.Options();
  o.setBinary(`${HOME}/firefox/firefox`);
  o.addArguments('-headless', '--width=1366', '--height=2000');
  const d = await new Builder().forBrowser('firefox').setFirefoxOptions(o)
    .setFirefoxService(new firefox.ServiceBuilder(`${HOME}/geckodriver`)).build();
  await d.installAddon(`${HOME}/bench-firefox.xpi`, true);
  return d;
}

// The application form's own URL, reached by navigation only.
async function formUrl(driver, url) {
  const u = url.replace(/\/+$/, '');
  if (/jobs\.lever\.co/.test(u)) return u.endsWith('/apply') ? u : `${u}/apply`;
  if (/ashbyhq\.com/.test(u)) return u.endsWith('/application') ? u : `${u}/application`;
  if (/breezy\.hr/.test(u)) return u.endsWith('/apply') ? u : `${u}/apply`;
  if (/workable\.com/.test(u)) {
    await driver.get(u); await sleep(4000);
    const cur = (await driver.getCurrentUrl()).replace(/\/+$/, '');
    return cur.endsWith('/apply') ? cur : `${cur}/apply/`;
  }
  if (/smartrecruiters\.com/.test(u)) {
    await driver.get(u); await sleep(4000);
    const href = await driver.executeScript(
      "const a=document.querySelector('a[href*=\"oneclick-ui\"]'); return a ? a.href : null;");
    return href || u;
  }
  return u; // Greenhouse: the form is on the job page
}

const DUMP = `
  const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const labelOf = el => {
    if (el.labels && el.labels[0]) return el.labels[0].textContent.trim();
    const al = el.getAttribute('aria-label'); if (al) return al;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(' ').map(id => document.getElementById(id)?.textContent || '').join(' ').trim(); if (t) return t; }
    let p = el.parentElement, hops = 0;
    while (p && hops < 5) { const l = p.querySelector('label, legend'); if (l && l.textContent.trim()) return l.textContent.trim(); p = p.parentElement; hops++; }
    return el.getAttribute('placeholder') || el.name || el.id || '';
  };
  const fields = []; const seenRadio = new Set();
  for (const el of document.querySelectorAll('input, textarea, select')) {
    const t = (el.type || el.tagName).toLowerCase();
    if (['hidden','submit','button','image','reset','search'].includes(t)) continue;
    if (el.closest('#recrutas-fill-btn, .recrutas-banner')) continue;
    if (el.getAttribute('role') === 'combobox' && el.closest('.select__control')) continue;
    if (!visible(el) && t !== 'file') continue;
    const label = labelOf(el).replace(/\\s+/g, ' ').slice(0, 70);
    let filled;
    if (t === 'radio') { const k = el.name || label; if (seenRadio.has(k)) continue; seenRadio.add(k);
      filled = !!document.querySelector('input[type=radio][name="' + CSS.escape(el.name) + '"]:checked'); }
    else if (t === 'checkbox') filled = el.checked;
    else if (t === 'file') filled = el.files && el.files.length > 0;
    else filled = !!(el.value || '').trim();
    const req = el.required || el.getAttribute('aria-required') === 'true' || /\\*\\s*$/.test(label);
    fields.push({ label, type: t, req, filled });
  }
  for (const c of document.querySelectorAll('.select__control')) {
    const v = c.querySelector('.select__single-value, .select__multi-value__label');
    const input = c.querySelector('input');
    const label = (input ? labelOf(input) : '').replace(/\\s+/g, ' ').slice(0, 70);
    fields.push({ label, type: 'dropdown', req: (input && input.getAttribute('aria-required') === 'true') || /\\*\\s*$/.test(label), filled: !!v });
  }
  return fields;`;

const driver = await build();
const results = [];
try {
  await driver.get('https://www.recrutas.ai/auth');
  await driver.executeScript('localStorage.setItem(arguments[0], arguments[1]);', LS_KEY, JSON.stringify(session));
  await driver.get('https://www.recrutas.ai/candidate-dashboard');
  await sleep(10000);

  for (const url of urls) {
    const r = { url, browser: BROWSER };
    try {
      r.form = await formUrl(driver, url);
      await driver.get(r.form);
      let btn = null;
      for (let i = 0; i < 12 && !btn; i++) {
        const els = await driver.findElements(By.id('recrutas-fill-btn'));
        if (els.length) btn = els[0]; else await sleep(1500);
      }
      r.before = await driver.executeScript(DUMP);
      if (!btn) { r.error = 'no fill button'; results.push(r); err(`${BROWSER} ✗ ${url} no button`); continue; }
      const t0 = Date.now();
      await driver.executeScript("document.getElementById('recrutas-fill-btn').click();");
      for (let i = 0; i < 80; i++) {
        await sleep(3000);
        r.banner = await driver.executeScript("return (document.getElementById('recrutas-banner')||{}).textContent||null;");
        if (r.banner && /filled \\d|could not|no form|sign in|expired|error|failed|timed out/i.test(r.banner)) break;
      }
      r.seconds = Math.round((Date.now() - t0) / 1000);
      await sleep(2000);
      r.fields = await driver.executeScript(DUMP);
      const req = r.fields.filter(f => f.req);
      err(`${BROWSER} ${url.split('/')[2]} | ${r.fields.filter(f => f.filled).length}/${r.fields.length} fields, required ${req.filter(f => f.filled).length}/${req.length} | ${r.seconds}s | ${(r.banner || '').trim().slice(0, 70)}`);
    } catch (e) { r.error = String(e.message || e).slice(0, 200); err(`${BROWSER} ✗ ${url} ${r.error}`); }
    results.push(r);
  }
} finally {
  await driver.quit();
}
console.log(JSON.stringify(results));
process.exit(0);
