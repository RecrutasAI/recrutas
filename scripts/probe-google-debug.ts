import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH,
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto('https://www.google.com/search?q=Natera,+San+Carlos&hl=en&gl=us', {
    waitUntil: 'domcontentloaded', timeout: 15000,
  });
  const title = await page.title();
  const url = page.url();
  const html = await page.content();
  console.log('title:', title);
  console.log('final url:', url);
  console.log('html length:', html.length);
  console.log('first 500 chars of body text:');
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '(no body)');
  console.log(text);
  console.log('---');
  console.log('first 20 anchor hrefs:');
  const hrefs = await page.$$eval('a', as => as.slice(0, 40).map(a => (a as HTMLAnchorElement).href));
  hrefs.forEach((h, i) => console.log(`[${i}] ${h}`));
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
