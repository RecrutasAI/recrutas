import 'dotenv/config';
import postgres from 'postgres';
import { chromium } from 'playwright';

async function searchFirstResult(query: string): Promise<string | null> {
  const browser = await chromium.launch({ 
    headless: true,
    executablePath: process.env.CHROME_PATH
  });
  const page = await browser.newPage();
  
  try {
    // Try Bing instead of Google
    await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, { 
      waitUntil: 'domcontentloaded',
      timeout: 20000 
    });
    await page.waitForTimeout(2000);
    
    const links = await page.$$eval('a', els => 
      els.filter(e => e.href?.startsWith('http') && !e.href.includes('bing.com') && !e.href.includes('microsoft.com'))
         .map(e => e.href)
    );
    return links[0] || null;
  } catch (e) {
    console.log(`  Search error: ${e}`);
    return null;
  } finally {
    await browser.close();
  }
}

function extractCity(location: string | null): string | null {
  if (!location) return null;
  const first = location.split(',')[0].trim();
  if (!first) return null;
  if (/^(remote|united states|us|usa)$/i.test(first)) return null;
  return first;
}

const AGGREGATOR_DOMAINS = ['adzuna', 'indeed', 'linkedin', 'glassdoor', 'ziprecruiter', 'monster', 'simplyhired'];

function looksLikeAggregator(url: string): boolean {
  const lower = url.toLowerCase();
  return AGGREGATOR_DOMAINS.some(d => lower.includes(d));
}

async function main() {
  const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL not set');
  const sql = postgres(url, { max: 1, prepare: false });

  const rows = await sql<Array<{ title: string; company: string; location: string | null }>>`
    SELECT title, company, location
    FROM job_postings
    WHERE source = 'Adzuna'
    ORDER BY RANDOM()
    LIMIT 10
  `;
  await sql.end();

  console.log(`Testing ${rows.length} Adzuna jobs with headless browser\n`);

  let resolved = 0;
  for (let i = 0; i < rows.length; i++) {
    const job = rows[i];
    const city = extractCity(job.location);
    const query = city ? `${job.company}, ${city}` : job.company;
    
    console.log(`[${i + 1}] ${job.company} (${city ?? 'no-city'})`);
    const resultUrl = await searchFirstResult(query);
    
    if (resultUrl && !looksLikeAggregator(resultUrl)) {
      resolved++;
      console.log(`    → ${resultUrl.slice(0, 80)}`);
    } else {
      console.log(`    → (no result)`);
    }
    
    await new Promise(r => setTimeout(r, 1000)); // be nice
  }

  console.log(`\nResolved ${resolved}/${rows.length} (${((resolved / rows.length) * 100).toFixed(0)}%)`);
}

main().catch(console.error);