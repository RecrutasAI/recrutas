// Submission-detection test in a real browser against tracking-fixture.py.
//   node tracking-e2e.mjs firefox|chrome
// Expects: the test build's API base points at the fixture's mock API (:8098),
// and recrutas-bench.breezy.hr resolves to 127.0.0.1.
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import chrome from 'selenium-webdriver/chrome.js';
import { readFileSync, readdirSync, existsSync, unlinkSync } from 'fs';

const BROWSER = process.argv[2] || 'firefox';
const HOME = `${process.env.HOME}/ext-e2e`;
const SITE = 'http://recrutas-bench.breezy.hr:8099';
const REPORTS = `${HOME}/tracking-reports.jsonl`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reports = () => existsSync(REPORTS) ? readFileSync(REPORTS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
let pass = true;
const check = (ok, name, extra = '') => { if (!ok) pass = false; console.log(`${ok ? 'PASS' : 'FAIL'} ${BROWSER} ${name}${extra ? ' — ' + extra : ''}`); };

async function build() {
  if (BROWSER === 'chrome') {
    const ver = readdirSync(`${HOME}/chrome-cft/chrome`).find(n => n.startsWith('linux-'));
    const o = new chrome.Options();
    o.setChromeBinaryPath(`${HOME}/chrome-cft/chrome/${ver}/chrome-linux64/chrome`);
    o.addArguments('--headless=new', '--no-sandbox', '--disable-dev-shm-usage', `--load-extension=${HOME}/tracking-chrome`, '--disable-features=DisableLoadExtensionCommandLineSwitch');
    return new Builder().forBrowser('chrome').setChromeOptions(o)
      .setChromeService(new chrome.ServiceBuilder(`${HOME}/chrome-cft/chromedriver/${ver}/chromedriver-linux64/chromedriver`)).build();
  }
  const o = new firefox.Options(); o.setBinary(`${HOME}/firefox/firefox`); o.addArguments('-headless');
  const d = await new Builder().forBrowser('firefox').setFirefoxOptions(o).setFirefoxService(new firefox.ServiceBuilder(`${HOME}/geckodriver`)).build();
  await d.installAddon(`${HOME}/tracking-firefox.xpi`, true);
  return d;
}

const banner = d => d.executeScript("return (document.getElementById('recrutas-banner')||{}).textContent||'';");
async function waitBanner(d, re, ms = 12000) {
  for (let t = 0; t < ms; t += 500) { const b = await banner(d); if (re.test(b)) return b; await sleep(500); }
  return await banner(d);
}

const d = await build();
try {
  if (existsSync(REPORTS)) unlinkSync(REPORTS);
  await d.get('https://www.recrutas.ai/auth');
  await d.executeScript('localStorage.setItem(arguments[0], arguments[1]);', 'sb-fgdxsvlamtinkepfodfj-auth-token', readFileSync(`${HOME}/session.json`, 'utf8'));
  await d.get('https://www.recrutas.ai/candidate-dashboard'); await sleep(9000);

  // 1. Navigation flow: form page -> /thanks
  await d.get(`${SITE}/p/abc123def456-support-engineer/apply`); await sleep(5000);
  await d.executeScript("document.getElementById('go').click();"); await sleep(1000);
  const b1 = await waitBanner(d, /saved to/i);
  let r = reports();
  check(r.length === 1, 'reports one submission after /thanks', `${r.length} report(s)`);
  check(r[0]?.postingUrl === `${SITE}/p/abc123def456-support-engineer/apply`, 'reports the posting URL', r[0]?.postingUrl);
  check(r[0]?.title === 'Support Engineer' && r[0]?.company === 'Bench Co', 'reports title and company', `${r[0]?.title} @ ${r[0]?.company}`);
  check(r[0]?._auth === 'Bearer ', 'sends the session token');
  check(/saved to Recrutas/i.test(b1), 'confirms to the candidate', b1.trim().slice(0, 80));
  check(!JSON.stringify(r[0] || {}).match(/first|email|phone/i), 'sends nothing typed into the form');

  // 2. Reload the confirmation page: must not report twice
  await d.navigate().refresh(); await sleep(5000);
  check(reports().length === 1, 'does not re-report on reload', `${reports().length} report(s)`);

  // 3. In-place flow (form replaced by confirmation text, same URL)
  await d.get(`${SITE}/p/inplace99887766-support-engineer/apply`); await sleep(5000);
  await d.executeScript("document.getElementById('go').click();");
  await waitBanner(d, /saved to/i);
  r = reports();
  check(r.length === 2 && /inplace/.test(r[1]?.postingUrl || ''), 'reports an in-place confirmation', `${r.length} report(s)`);

  // 4. A form page with no submission must not report
  await d.get(`${SITE}/p/nosubmit1234-support-engineer/apply`); await sleep(6000);
  check(reports().length === 2, 'no report without a confirmation');

  // 5. Already applied: warning on the form page
  await d.get(`${SITE}/p/qa55aa66bb77-qa-engineer/apply`);
  const b5 = await waitBanner(d, /already applied/i);
  check(/already applied to this job on/i.test(b5), 'warns about a duplicate application', b5.trim().slice(0, 80));
} catch (e) {
  pass = false; console.log('ERROR', e.message);
} finally {
  await d.quit();
}
console.log(pass ? `ALL PASS ${BROWSER}` : `SOME FAILED ${BROWSER}`);
process.exit(pass ? 0 : 1);
