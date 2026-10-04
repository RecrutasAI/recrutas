// Click Fill on one form and record every banner / button-text change for 4
// minutes, so a stalled or failed fill shows where it stopped.
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { readFileSync } from 'fs';
const HOME = `${process.env.HOME}/ext-e2e`;
const o = new firefox.Options(); o.setBinary(`${HOME}/firefox/firefox`); o.addArguments('-headless');
const d = await new Builder().forBrowser('firefox').setFirefoxOptions(o).setFirefoxService(new firefox.ServiceBuilder(`${HOME}/geckodriver`)).build();
await d.installAddon(`${HOME}/bench-firefox.xpi`, true);
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  await d.get('https://www.recrutas.ai/auth');
  await d.executeScript('localStorage.setItem(arguments[0], arguments[1]);', 'sb-fgdxsvlamtinkepfodfj-auth-token', readFileSync(`${HOME}/session.json`, 'utf8'));
  await d.get('https://www.recrutas.ai/candidate-dashboard'); await sleep(10000);
  await d.get(process.argv[2]); await sleep(8000);
  await d.executeScript("document.getElementById('recrutas-fill-btn').click();");
  const t0 = Date.now(); let last = '';
  while (Date.now() - t0 < 240000) {
    const s = await d.executeScript("const b=document.getElementById('recrutas-banner'), f=document.getElementById('recrutas-fill-btn'); return (f?f.textContent.trim():'-')+' || '+(b?b.textContent.trim():'-');");
    if (s !== last) { console.log(`${Math.round((Date.now() - t0) / 1000)}s ${s.slice(0, 160)}`); last = s; }
    await sleep(1000);
  }
} finally { await d.quit(); }
