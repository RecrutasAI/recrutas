// Describe a page's form structure: shadow roots (open/closed), inputs inside
// them, iframes, and whether the extension's button got injected.
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
const HOME = `${process.env.HOME}/ext-e2e`;
const o = new firefox.Options(); o.setBinary(`${HOME}/firefox/firefox`); o.addArguments('-headless');
const d = await new Builder().forBrowser('firefox').setFirefoxOptions(o).setFirefoxService(new firefox.ServiceBuilder(`${HOME}/geckodriver`)).build();
await d.installAddon(`${HOME}/bench-firefox.xpi`, true);
try {
  await d.get(process.argv[2]); await new Promise(r => setTimeout(r, 15000));
  console.log(JSON.stringify(await d.executeScript(`
    const hosts = [...document.querySelectorAll('*')].filter(e => e.shadowRoot);
    const all = [...document.querySelectorAll('*')];
    const customEls = [...new Set(all.map(e => e.tagName.toLowerCase()).filter(t => t.includes('-')))].slice(0, 25);
    let shadowInputs = 0; const walk = r => { for (const e of r.querySelectorAll('*')) { if (e.shadowRoot) { shadowInputs += e.shadowRoot.querySelectorAll('input,textarea,select').length; walk(e.shadowRoot); } } }; walk(document);
    return { url: location.href, title: document.title, lightInputs: document.querySelectorAll('input:not([type=hidden]),textarea,select').length,
      openShadowHosts: hosts.length, shadowInputs, iframes: [...document.querySelectorAll('iframe')].map(f => f.src.slice(0, 90)),
      customEls, button: !!document.getElementById('recrutas-fill-btn') };`), null, 1));
} finally { await d.quit(); }
