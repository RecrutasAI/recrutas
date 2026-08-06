/**
 * Company Discovery Pipeline
 *
 * Automatically discovers new companies to scrape by:
 * - Monitoring job postings for new company names
 * - Detecting ATS type from career page URL patterns
 * - Queueing companies for review/scraper addition
 *
 */

import { db } from './db';
import { jobPostings, discoveredCompanies } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { sql, isNotNull, ne } from 'drizzle-orm/sql';
import { wikipediaDiscovery } from './wikipedia-discovery'; // NEW
import { TECH_TITLE_PATTERN } from './lib/tech-roles';

// ATS detection patterns
const ATS_PATTERNS = {
  greenhouse: [
    /boards\.greenhouse\.io/i,
    /greenhouse\.io\/[\w-]+\/jobs/i,
    /jobs\.greenhouse\.io/i
  ],
  lever: [
    /jobs\.lever\.co/i,
    /lever\.co\/[\w-]+/i
  ],
  workday: [
    /myworkdayjobs\.com/i,
    /workday\.com.*careers/i,
    /\.wd\d+\.myworkdayjobs/i
  ],
  ashby: [
    /jobs\.ashbyhq\.com/i,
    /ashbyhq\.com\/[\w-]+/i
  ],
  bamboohr: [
    /[\w-]+\.bamboohr\.com\/careers/i,
    /bamboohr\.com\/hiring/i
  ],
  icims: [
    /icims\.com/i,
    /careers-[\w-]+\.icims\.com/i
  ],
  jobvite: [
    /jobs\.jobvite\.com/i,
    /[\w-]+\.jobvite\.com/i
  ],
  smartrecruiters: [
    /jobs\.smartrecruiters\.com/i,
    /careers\.smartrecruitters\.com/i
  ],
  taleo: [
    /taleo\.net/i,
    /[\w-]+\.taleo\.net/i
  ],
  successfactors: [
    /successfactors\.com/i,
    /jobs\.sap\.com/i
  ]
};

// Companies we already scrape (to avoid duplicates)
const KNOWN_COMPANIES = new Set([
  'stripe', 'airbnb', 'discord', 'figma', 'notion', 'coinbase', 'instacart',
  'robinhood', 'plaid', 'ramp', 'netflix', 'twilio', 'cloudflare', 'google',
  'microsoft', 'apple', 'amazon', 'meta', 'spotify', 'shopify', 'github',
  'linear', 'vercel', 'supabase', 'datadog', 'duolingo', 'hashicorp', 'snyk',
  'gitlab', 'databricks', 'carta', 'brex', 'scale ai', 'deel', 'remote.com',
  'retool', 'benchling', 'mercury', 'rippling', 'anduril', 'cockroach labs',
  'amplitude', 'launchdarkly', 'segment', 'flexport', 'airtable', 'webflow',
  'canva', 'loom', 'postman', 'grammarly', 'miro', 'asana', 'intercom',
  'calendly', 'zapier', 'gusto', 'dbt labs', 'salesforce', 'vmware', 'adobe',
  'workday', 'servicenow', 'nvidia', 'visa', 'target', 'openai', 'anthropic',
  'palantir', 'doordash', 'uber', 'lyft', 'pinterest', 'snap', 'reddit'
]);

type DiscoveredCompany = typeof discoveredCompanies.$inferSelect;

interface CompanyDiscoveryStats {
  totalDiscovered: number;
  pendingReview: number;
  approved: number;
  rejected: number;
  byAtsType: Record<string, number>;
}

class CompanyDiscoveryPipeline {
  private discoveryInterval: NodeJS.Timeout | null = null;

  /**
   * Start the discovery pipeline
   */
  start(): void {
    console.log('[CompanyDiscovery] Starting company discovery pipeline...');

    // Run initial discovery
    this.runDiscovery().catch(console.error);

    // Schedule periodic discovery every 24 hours
    this.discoveryInterval = setInterval(() => {
      this.runDiscovery().catch(console.error);
    }, 24 * 60 * 60 * 1000);
  }

  /**
   * Stop the discovery pipeline
   */
  stop(): void {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }
    console.log('[CompanyDiscovery] Stopped company discovery pipeline');
  }

  async saveCompaniesToDatabase(companies: Array<{
    name: string;
    normalizedName: string;
    careerPageUrl?: string;
    detectedAts?: string;
    atsId?: string;
    jobCount: number;
    techScore?: number;
    source: string;
  }>): Promise<void> {
    if (companies.length === 0) return;

    // Dedupe by normalizedName so a single bulk upsert can't trip on duplicate keys.
    const byName = new Map<string, typeof companies[number]>();
    for (const c of companies) byName.set(c.normalizedName, c);
    const unique = Array.from(byName.values());

    const CHUNK = 1000;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const batch = unique.slice(i, i + CHUNK);
      try {
        await db.insert(discoveredCompanies)
          .values(batch.map(c => ({
            name: c.name,
            normalizedName: c.normalizedName,
            careerPageUrl: c.careerPageUrl,
            detectedAts: c.detectedAts,
            atsId: c.atsId,
            jobCount: c.jobCount,
            techScore: c.techScore ?? 0,
            discoverySource: c.source,
            status: 'pending',
          })))
          .onConflictDoUpdate({
            target: discoveredCompanies.normalizedName,
            set: {
              jobCount: sql`excluded."jobCount"`,
              // Refresh on every run — a company's mix shifts as we ingest more
              // of its postings, and a stale score would freeze its queue rank.
              techScore: sql`excluded."techScore"`,
              updatedAt: new Date(),
            },
          });
      } catch (error) {
        console.error(`[CompanyDiscovery] Bulk upsert error for chunk ${i}–${i + batch.length}:`, (error as Error).message);
      }
    }
  }

  /**
   * Run the discovery process
   */
  async runDiscovery(): Promise<void> {
    console.log('[CompanyDiscovery] Running company discovery...');

    try {
      const allCompanies: Array<any> = [];

      // 1. Existing: Mine job postings
      const jobCompanies = await this.getUniqueCompaniesFromJobs();
      console.log(`[CompanyDiscovery] Found ${jobCompanies.length} companies from job postings`);

      for (const comp of jobCompanies) {
        const normalizedName = this.normalizeCompanyName(comp.company);
        if (KNOWN_COMPANIES.has(normalizedName)) {continue;}

        const atsType = comp.careerPageUrl ? this.detectAtsType(comp.careerPageUrl) : undefined;

        allCompanies.push({
          name: comp.company,
          normalizedName,
          careerPageUrl: comp.careerPageUrl,
          detectedAts: atsType,
          atsId: this.extractAtsId(comp.careerPageUrl || '', atsType),
          jobCount: comp.count,
          techScore: comp.techScore,
          source: 'job_mining'
        });
      }

      // 2. NEW: Run Wikipedia discovery (weekly)
      if (this.shouldRunWikipediaDiscovery()) {
        const wikiCompanies = await wikipediaDiscovery.discoverFromFortune500();

        for (const comp of wikiCompanies) {
          const normalizedName = this.normalizeCompanyName(comp.name);
          if (KNOWN_COMPANIES.has(normalizedName)) {continue;}

          // Try to find career page URL
          const careerUrl = await this.timeout(5000, this.findCareerPageUrl(comp.name)).catch(() => null);
          const atsType = careerUrl ? this.detectAtsType(careerUrl) : undefined;

          allCompanies.push({
            name: comp.name,
            normalizedName,
            careerPageUrl: careerUrl || undefined,
            detectedAts: atsType,
            atsId: this.extractAtsId(careerUrl || '', atsType),
            jobCount: 0,
            source: 'wikipedia'
          });
        }
      }

      // 3. Save all to database
      await this.saveCompaniesToDatabase(allCompanies);
      console.log(`[CompanyDiscovery] Saved ${allCompanies.length} companies to database`);

      // 4. Auto-approve high-value companies
      await this.autoApproveHighValueCompanies();

    } catch (error) {
      console.error('[CompanyDiscovery] Error during discovery:', error);
    }
  }

  private shouldRunWikipediaDiscovery(): boolean {
    // Disabled: 0% probe yield in production (companies are already in our catalog
    // or have no public ATS). Re-enable by returning a date-based gate if reviving.
    return false;
  }

  private extractAtsId(url: string, atsType?: string): string | undefined {
    if (!atsType || !url) {return undefined;}

    if (atsType === 'greenhouse') {
      return this.extractGreenhouseId(url) || undefined;
    } else if (atsType === 'lever') {
      return this.extractLeverId(url) || undefined;
    }

    return undefined;
  }


  /**
   * Get unique companies from job postings
   */
  private async getUniqueCompaniesFromJobs(): Promise<Array<{ company: string; count: number; careerPageUrl?: string; techScore: number }>> {
    const result = await db.select({
      company: jobPostings.company,
      count: sql<number>`count(*)`,
      careerPageUrl: sql<string>`max(${jobPostings.careerPageUrl})`,
      // 0-100 share of this company's postings that look like tech roles. Feeds
      // the probe-queue tiebreaker so the ~14K-deep backlog converts toward tech
      // instead of toward whoever posts the most. Ranking only — see
      // server/lib/tech-roles.ts for why this is deliberately not a filter.
      techScore: sql<number>`round(100.0 * count(*) filter (where ${jobPostings.title} ~* ${TECH_TITLE_PATTERN}) / count(*))`,
    })
    .from(jobPostings)
    .where(isNotNull(jobPostings.company))
    .groupBy(jobPostings.company)
    .having(sql`count(*) >= 1`);

    return result.map(row => ({
      company: row.company,
      count: Number(row.count),
      careerPageUrl: row.careerPageUrl || undefined,
      techScore: Number(row.techScore) || 0,
    }));
  }

  /**
   * Normalize company name for comparison
   */
  private normalizeCompanyName(name: string): string {
    return name
      .toLowerCase()
      .replace(/,?\s*(inc|llc|ltd|corp|corporation|co|company)\.?$/i, '')
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  /**
   * Detect ATS type from career page URL
   */
  detectAtsType(url: string): string | undefined {
    for (const [atsName, patterns] of Object.entries(ATS_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(url)) {
          return atsName;
        }
      }
    }
    return undefined;
  }

  /**
   * Auto-approve companies with high job counts and known ATS
   */
  private timeout<T>(ms: number, promise: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Promise timed out'));
      }, ms);

      promise.then(
        (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  private async autoApproveHighValueCompanies(): Promise<void> {
    const MIN_JOB_COUNT = 5;
    const ATS_WITH_API = new Set(['greenhouse', 'lever']);

    // Query pending companies from database
    const pending = await db.select()
      .from(discoveredCompanies)
      .where(eq(discoveredCompanies.status, 'pending'));

    let autoApproved = 0;

    for (const company of pending) {
      if (
        company.jobCount >= MIN_JOB_COUNT &&
        company.detectedAts &&
        ATS_WITH_API.has(company.detectedAts)
      ) {
        await db.update(discoveredCompanies)
          .set({ status: 'approved' })
          .where(eq(discoveredCompanies.id, company.id));

        autoApproved++;
      }
    }

    if (autoApproved > 0) {
      console.log(`[CompanyDiscovery] Auto-approved ${autoApproved} companies`);
    }
  }

  async getDiscoveredCompanies(): Promise<DiscoveredCompany[]> {
    return db.select().from(discoveredCompanies);
  }

  async getPendingCompanies(): Promise<DiscoveredCompany[]> {
    return db.select()
      .from(discoveredCompanies)
      .where(eq(discoveredCompanies.status, 'pending'))
      .orderBy(discoveredCompanies.jobCount.desc()); // Corrected
  }

  async getApprovedCompanies(): Promise<DiscoveredCompany[]> {
    return db.select()
      .from(discoveredCompanies)
      .where(eq(discoveredCompanies.status, 'approved'))
      .orderBy(discoveredCompanies.jobCount.desc()); // Corrected
  }

  async approveCompany(normalizedName: string): Promise<boolean> {
    const result = await db.update(discoveredCompanies)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(eq(discoveredCompanies.normalizedName, normalizedName));
    return (result.count ?? 0) > 0;
  }

  async rejectCompany(normalizedName: string): Promise<boolean> {
    const result = await db.update(discoveredCompanies)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(eq(discoveredCompanies.normalizedName, normalizedName));
    return (result.count ?? 0) > 0;
  }

  async markAsInScraper(normalizedName: string): Promise<boolean> {
    const result = await db.update(discoveredCompanies)
      .set({ status: 'in_scraper', updatedAt: new Date() })
      .where(eq(discoveredCompanies.normalizedName, normalizedName));

    if ((result.count ?? 0) > 0) {
      KNOWN_COMPANIES.add(normalizedName);
      return true;
    }
    return false;
  }

  async getStatistics(): Promise<CompanyDiscoveryStats> {
    const companies = await this.getDiscoveredCompanies();
    const byAtsType: Record<string, number> = {};

    for (const company of companies) {
      if (company.detectedAts) {
        byAtsType[company.detectedAts] = (byAtsType[company.detectedAts] || 0) + 1;
      }
    }

    return {
      totalDiscovered: companies.length,
      pendingReview: companies.filter(c => c.status === 'pending').length,
      approved: companies.filter(c => c.status === 'approved').length,
      rejected: companies.filter(c => c.status === 'rejected').length,
      byAtsType
    };
  }

  async generateScraperConfig(): Promise<string> {
    const approved = await this.getApprovedCompanies();
    const configs: string[] = [];

    for (const company of approved) {
      let config = `{ name: '${company.name}', careerUrl: '${company.careerPageUrl || ''}'`;

      if (company.detectedAts === 'greenhouse') {
        // Extract greenhouse ID from URL or use normalized name
        const greenhouseId = this.extractGreenhouseId(company.careerPageUrl || '') || company.normalizedName.replace(/\s+/g, '');
        config += `, greenhouseId: '${greenhouseId}'`;
      } else if (company.detectedAts === 'lever') {
        const leverId = this.extractLeverId(company.careerPageUrl || '') || company.normalizedName.replace(/\s+/g, '');
        config += `, leverId: '${leverId}'`;
      } else if (company.detectedAts === 'workday') {
        const workdayId = company.normalizedName.replace(/\s+/g, '');
        config += `, workdayId: '${workdayId}'`;
      }

      config += ' },';
      configs.push(config);
    }

    return configs.join('\n');
  }

  /**
   * Extract Greenhouse ID from URL
   */
  private extractGreenhouseId(url: string): string | null {
    const match = url.match(/boards\.greenhouse\.io\/(\w+)/i) ||
                  url.match(/greenhouse\.io\/(\w+)\/jobs/i);
    return match ? match[1] : null;
  }

  /**
   * Extract Lever ID from URL
   */
  private extractLeverId(url: string): string | null {
    const match = url.match(/jobs\.lever\.co\/(\w+)/i) ||
                  url.match(/lever\.co\/(\w+)/i);
    return match ? match[1] : null;
  }

  /**
   * Find career page URL for a company using common patterns
   */
  async findCareerPageUrl(companyName: string): Promise<string | null> {
    const normalizedName = companyName.toLowerCase().replace(/\s+/g, '');

    // Common career page URL patterns
    const urlPatterns = [
      `https://${normalizedName}.com/careers`,
      `https://careers.${normalizedName}.com`,
      `https://www.${normalizedName}.com/careers`,
      `https://jobs.${normalizedName}.com`,
      `https://${normalizedName}.com/jobs`,
      `https://boards.greenhouse.io/${normalizedName}`,
      `https://jobs.lever.co/${normalizedName}`
    ];

    for (const url of urlPatterns) {
      try {
        const response = await fetch(url, {
          method: 'HEAD',
          headers: { 'User-Agent': 'RecrutasJobAggregator/1.0' }
        });

        if (response.ok) {
          return url;
        }
      } catch {
        // URL not reachable, try next
      }
    }

    return null;
  }
}

// Export singleton instance
export const companyDiscoveryPipeline = new CompanyDiscoveryPipeline();
