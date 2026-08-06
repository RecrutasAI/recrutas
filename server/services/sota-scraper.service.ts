/**
 * SOTA Scraper Integration Layer
 * 
 * Integrates the new SOTA scraper with the existing job ingestion system.
 * This adapter converts SOTA scraper output to the format expected by
 * job-ingestion.service.ts
 */

import { ScraperOrchestrator, CompanyConfig } from '../scraper-v2/index.js';
import { ScrapedJob } from '../scraper-v2/types.js';
import { jobIngestionService, ExternalJobInput } from './job-ingestion.service.js';
import { logger } from '../scraper-v2/utils/logger.js';
import { companyDiscoveryService, DiscoveredCompany } from './company-discovery.service.js';
import { atsDetectionService } from './ats-detection.service.js';
import { deriveWorkdayApiUrl } from '../scraper-v2/strategies/ats-apis.js';
import { db } from '../db.js';
import { discoveredCompanies } from '../../shared/schema.js';
import { and, eq } from 'drizzle-orm';
import { inArray } from 'drizzle-orm/sql/expressions';

// Import the company list from career-page-scraper and convert to SOTA format
// Synced with server/career-page-scraper.ts — keep both in sync when adding companies
const LEGACY_COMPANIES = [
  // ============================================
  // GREENHOUSE ATS (all IDs verified 200)
  // ============================================
  { name: 'Stripe', careerUrl: 'https://stripe.com/jobs', greenhouseId: 'stripe' },
  { name: 'Airbnb', careerUrl: 'https://careers.airbnb.com/', greenhouseId: 'airbnb' },
  { name: 'Discord', careerUrl: 'https://discord.com/careers', greenhouseId: 'discord' },
  { name: 'Figma', careerUrl: 'https://www.figma.com/careers/', greenhouseId: 'figma' },
  { name: 'Coinbase', careerUrl: 'https://www.coinbase.com/careers', greenhouseId: 'coinbase' },
  { name: 'Instacart', careerUrl: 'https://careers.instacart.com/', greenhouseId: 'instacart' },
  { name: 'Robinhood', careerUrl: 'https://robinhood.com/us/en/careers/', greenhouseId: 'robinhood' },
  { name: 'Datadog', careerUrl: 'https://careers.datadoghq.com/', greenhouseId: 'datadog' },
  { name: 'Duolingo', careerUrl: 'https://careers.duolingo.com/', greenhouseId: 'duolingo' },
  { name: 'GitLab', careerUrl: 'https://about.gitlab.com/jobs/', greenhouseId: 'gitlab' },
  { name: 'Databricks', careerUrl: 'https://databricks.com/careers', greenhouseId: 'databricks' },
  { name: 'Carta', careerUrl: 'https://carta.com/careers/', greenhouseId: 'carta' },
  { name: 'Brex', careerUrl: 'https://www.brex.com/careers', greenhouseId: 'brex' },
  { name: 'Scale AI', careerUrl: 'https://scale.com/careers', greenhouseId: 'scaleai' },
  { name: 'Remote.com', careerUrl: 'https://remote.com/careers', greenhouseId: 'remotecom' },
  { name: 'Mercury', careerUrl: 'https://mercury.com/careers', greenhouseId: 'mercury' },
  { name: 'Cockroach Labs', careerUrl: 'https://www.cockroachlabs.com/careers/', greenhouseId: 'cockroachlabs' },
  { name: 'Amplitude', careerUrl: 'https://amplitude.com/careers', greenhouseId: 'amplitude' },
  { name: 'LaunchDarkly', careerUrl: 'https://launchdarkly.com/careers/', greenhouseId: 'launchdarkly' },
  { name: 'Anduril', careerUrl: 'https://www.anduril.com/careers/', greenhouseId: 'andurilindustries' },
  // Migrated from Lever (confirmed on Greenhouse)
  { name: 'Cloudflare', careerUrl: 'https://www.cloudflare.com/careers/', greenhouseId: 'cloudflare' },
  { name: 'Twilio', careerUrl: 'https://www.twilio.com/company/jobs', greenhouseId: 'twilio' },
  { name: 'Flexport', careerUrl: 'https://www.flexport.com/careers/', greenhouseId: 'flexport' },
  { name: 'Airtable', careerUrl: 'https://airtable.com/careers', greenhouseId: 'airtable' },
  { name: 'Webflow', careerUrl: 'https://webflow.com/careers', greenhouseId: 'webflow' },
  { name: 'Grammarly', careerUrl: 'https://www.grammarly.com/jobs', greenhouseId: 'grammarly' },
  { name: 'Asana', careerUrl: 'https://asana.com/jobs', greenhouseId: 'asana' },
  { name: 'Intercom', careerUrl: 'https://www.intercom.com/careers', greenhouseId: 'intercom' },
  { name: 'Calendly', careerUrl: 'https://calendly.com/careers', greenhouseId: 'calendly' },
  { name: 'Gusto', careerUrl: 'https://gusto.com/company/careers', greenhouseId: 'gusto' },
  { name: 'Postman', careerUrl: 'https://www.postman.com/company/careers/', greenhouseId: 'postman' },
  { name: 'Algolia', careerUrl: 'https://www.algolia.com/careers', greenhouseId: 'algolia' },
  { name: 'Contentful', careerUrl: 'https://www.contentful.com/careers/', greenhouseId: 'contentful' },
  { name: 'Pendo', careerUrl: 'https://www.pendo.io/careers/', greenhouseId: 'pendo' },
  { name: 'Faire', careerUrl: 'https://www.faire.com/careers', greenhouseId: 'faire' },
  { name: 'Lattice', careerUrl: 'https://lattice.com/careers', greenhouseId: 'lattice' },

  // ============================================
  // LEVER ATS (verified 200 — 2026-03-20)
  // ============================================
  { name: 'Palantir', careerUrl: 'https://www.palantir.com/careers/', leverId: 'palantir' },
  { name: 'Ro', careerUrl: 'https://ro.co/careers/', leverId: 'ro' },

  // ============================================
  // ASHBY ATS (free public API)
  // ============================================
  { name: 'Linear', careerUrl: 'https://linear.app/careers', ashbyId: 'linear' },
  { name: 'Notion', careerUrl: 'https://www.notion.so/careers', ashbyId: 'notion' },
  { name: 'Retool', careerUrl: 'https://retool.com/careers', ashbyId: 'retool' },
  { name: 'Loom', careerUrl: 'https://www.loom.com/careers', ashbyId: 'loom' },
  { name: 'Ramp', careerUrl: 'https://ramp.com/careers', ashbyId: 'ramp' },
  { name: 'Deel', careerUrl: 'https://www.deel.com/careers', ashbyId: 'deel' },
  { name: 'Plaid', careerUrl: 'https://plaid.com/careers/', ashbyId: 'plaid' },
  { name: 'Benchling', careerUrl: 'https://www.benchling.com/careers', ashbyId: 'benchling' },
  { name: 'Coda', careerUrl: 'https://coda.io/jobs', ashbyId: 'coda' },
  { name: 'Superhuman', careerUrl: 'https://superhuman.com/careers', ashbyId: 'superhuman' },

  // ============================================
  // WORKDAY ATS — workdayBoardUrl derives JSON API endpoint
  // ============================================
  { name: 'Salesforce', careerUrl: 'https://careers.salesforce.com/jobs', workdayId: 'salesforce', workdayBoardUrl: 'https://salesforce.wd12.myworkdayjobs.com/External_Career_Site' },
  { name: 'Adobe', careerUrl: 'https://careers.adobe.com/us/en/search-results', workdayId: 'adobe', workdayBoardUrl: 'https://adobe.wd5.myworkdayjobs.com/external_experienced' },
  { name: 'Workday', careerUrl: 'https://workday.wd5.myworkdayjobs.com/Workday', workdayId: 'workday', workdayBoardUrl: 'https://workday.wd5.myworkdayjobs.com/Workday' },
  { name: 'Nvidia', careerUrl: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite', workdayId: 'nvidia', workdayBoardUrl: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite' },
  // ServiceNow API blocks external requests — page-based fallback only
  { name: 'ServiceNow', careerUrl: 'https://careers.servicenow.com/', workdayId: 'servicenow' },

  // ============================================
  // Custom career pages (AI extraction / Firecrawl)
  // ============================================
  { name: 'Google', careerUrl: 'https://careers.google.com/jobs/results/' },
  { name: 'Microsoft', careerUrl: 'https://careers.microsoft.com/us/en/search-results' },
  { name: 'Apple', careerUrl: 'https://jobs.apple.com/en-us/search' },
  { name: 'Amazon', careerUrl: 'https://www.amazon.jobs/en/search' },
  { name: 'Meta', careerUrl: 'https://www.metacareers.com/jobs/' },
  { name: 'Spotify', careerUrl: 'https://www.lifeatspotify.com/jobs' },
  { name: 'Shopify', careerUrl: 'https://www.shopify.com/careers' },
  { name: 'GitHub', careerUrl: 'https://github.com/about/careers' },
  { name: 'Vercel', careerUrl: 'https://vercel.com/careers' },
  { name: 'Supabase', careerUrl: 'https://supabase.com/careers' },
  { name: 'OpenAI', careerUrl: 'https://openai.com/careers/' },
  { name: 'Anthropic', careerUrl: 'https://www.anthropic.com/careers' },
  { name: 'Palantir', careerUrl: 'https://www.palantir.com/careers/' },
  { name: 'DoorDash', careerUrl: 'https://careers.doordash.com/' },
  { name: 'Uber', careerUrl: 'https://www.uber.com/us/en/careers/' },
  { name: 'Lyft', careerUrl: 'https://www.lyft.com/careers' },
  { name: 'Pinterest', careerUrl: 'https://www.pinterestcareers.com/' },
  { name: 'Snap', careerUrl: 'https://careers.snap.com/' },
  { name: 'Reddit', careerUrl: 'https://www.redditinc.com/careers' },
  { name: 'Zapier', careerUrl: 'https://zapier.com/jobs' },
  { name: 'Canva', careerUrl: 'https://www.canva.com/careers/' },
  { name: 'Segment', careerUrl: 'https://segment.com/jobs/' },
  { name: 'Miro', careerUrl: 'https://miro.com/careers/' },
  { name: 'Rippling', careerUrl: 'https://www.rippling.com/careers' },
];

/**
 * Convert legacy company config to SOTA format
 */
function convertToSOTAConfig(legacy: any): CompanyConfig {
  const id = legacy.name.toLowerCase().replace(/\s+/g, '-');
  
  let ats = undefined;
  let strategies: string[];

  if (legacy.greenhouseId) {
    ats = { type: 'greenhouse' as const, boardId: legacy.greenhouseId };
    strategies = ['api', 'json_ld', 'ai_extraction'];
  } else if (legacy.ashbyId) {
    ats = { type: 'ashby' as const, boardId: legacy.ashbyId };
    strategies = ['api', 'json_ld', 'ai_extraction'];
  } else if (legacy.leverId) {
    ats = { type: 'lever' as const, boardId: legacy.leverId };
    strategies = ['api', 'json_ld', 'ai_extraction'];
  } else if (legacy.workdayBoardUrl) {
    // Workday public JSON API — derive endpoint from *.myworkdayjobs.com board URL
    const apiUrl = deriveWorkdayApiUrl(legacy.workdayBoardUrl);
    ats = { type: 'workday' as const, customApiUrl: apiUrl };
    strategies = ['api', 'json_ld', 'ai_extraction'];
  } else if (legacy.workdayId) {
    // workdayId without a board URL — fall back to page-based strategies
    strategies = ['firecrawl', 'json_ld', 'ai_extraction', 'html_parsing'];
  } else {
    // Custom career page (no known ATS) — Firecrawl handles JS rendering first
    strategies = ['firecrawl', 'json_ld', 'ai_extraction', 'html_parsing'];
  }
  
  return {
    id,
    name: legacy.name,
    displayName: legacy.name,
    website: legacy.careerUrl,
    careerPageUrl: legacy.careerUrl,
    ats,
    scrapeConfig: {
      strategies: strategies as any,
      pagination: { type: 'none', maxPages: 1 }
    },
    scrapeFrequency: 'daily',
    isActive: true,
    priority: ats ? 'high' : 'medium'
  };
}

/**
 * Convert SOTA scraped job to ingestion format
 */
export function convertToIngestionFormat(job: ScrapedJob): ExternalJobInput {
  // Generate external ID from job ID or create one
  const externalId = job.id || `${job.company}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Extract requirements as strings
  const requirements = job.requirements?.map(r => r.description) || [];
  
  // Determine work type
  const workType = (job.workType as 'remote' | 'hybrid' | 'onsite') || 'hybrid';
  
  // Get source from job metadata
  const source = job.source?.ats || job.source?.type || 'external';
  
  return {
    title: job.title,
    company: job.company,
    location: job.location?.raw || 'Remote',
    description: job.description,
    requirements,
    skills: job.skills || [],
    workType,
    salaryMin: job.salary?.min,
    salaryMax: job.salary?.max,
    source,
    externalId,
    externalUrl: job.externalUrl,
    postedDate: job.postedDate?.toISOString() || new Date().toISOString()
  };
}

export interface ScrapeResult {
  success: boolean;
  companiesScraped: number;
  totalJobsFound: number;
  jobsIngested: number;
  errors: string[];
  duration: number;
}

/**
 * SOTA Scraper Service
 * Main entry point for scraping with the new system
 */
export class SOTAScraperService {
  private companies: CompanyConfig[];
  private orchestrator: ScraperOrchestrator;

  constructor() {
    this.companies = LEGACY_COMPANIES.map(convertToSOTAConfig);
    this.mergeDiscoveredCompanies();
    this.orchestrator = new ScraperOrchestrator();
    logger.info(`Initialized SOTA scraper with ${this.companies.length} companies`);
  }

  /**
   * Merge in verified companies from CompanyDiscoveryService that aren't already in LEGACY_COMPANIES.
   * Only adds companies with confidence >= 1.0 and a known ATS type.
   */
  private mergeDiscoveredCompanies(): void {
    const existingNames = new Set(this.companies.map(c => c.name.toLowerCase()));
    const verified = companyDiscoveryService.getVerifiedCompanies();

    for (const dc of verified) {
      if (existingNames.has(dc.name.toLowerCase())) {continue;}
      if (dc.atsType === 'unknown' || dc.atsType === 'custom') {continue;}
      if (!dc.atsId) {continue;}

      const legacy = this.discoveredToLegacy(dc);
      const config = convertToSOTAConfig(legacy);
      this.companies.push(config);
      existingNames.add(dc.name.toLowerCase());
    }
  }

  /**
   * Convert a DiscoveredCompany to the legacy format used by convertToSOTAConfig
   */
  private discoveredToLegacy(dc: DiscoveredCompany): any {
    const base: any = { name: dc.name, careerUrl: dc.careerUrl };
    if (dc.atsType === 'greenhouse') {base.greenhouseId = dc.atsId;}
    else if (dc.atsType === 'lever') {base.leverId = dc.atsId;}
    else if (dc.atsType === 'workday') {base.workdayId = dc.atsId;}
    return base;
  }

  /**
   * Merge APPROVED companies from the `discovered_companies` TABLE.
   *
   * ⚠️ Not the same thing as mergeDiscoveredCompanies() above, which merges the
   * hardcoded KNOWN_COMPANIES array inside company-discovery.service.ts. That
   * name collision is how this gap survived: the nightly discover → probe →
   * approve pipeline wrote `status='approved'` for 1,956 companies and NOTHING
   * ever scraped them. `career-page-scraper.ts` has a loadDynamicCompanies()
   * that does this correctly, but its only caller (JobRefreshService) is
   * started from server/index.ts inside the background-services block, which is
   * disabled on serverless and never runs on the VPS. The crons reach
   * scrapeSubset() here instead, which read a hardcoded list only.
   *
   * STAGED ROLLOUT: scoped by SCRAPER_DYNAMIC_SOURCES (default 'seed') so this
   * starts with the ~114 curated tech companies rather than opening tier 1 from
   * ~90 to ~2,000 companies in a single run — this box has a history of tier-1
   * timeouts and exit-134 heap deaths. Widen by setting the env var (e.g.
   * 'seed,apollo:ai-data' or 'seed,job_mining') once runtime and memory are
   * measured. No code change needed to widen.
   *
   * Async + memoized: the constructor cannot await, so scrapeSubset()/scrapeAll()
   * call this before selecting a tier.
   */
  private dynamicMergeDone = false;

  private async mergeApprovedFromDatabase(): Promise<void> {
    if (this.dynamicMergeDone) {return;}
    this.dynamicMergeDone = true;
    if (!db) {return;}

    const scope = (process.env.SCRAPER_DYNAMIC_SOURCES ?? 'seed')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (scope.length === 0) {return;}

    try {
      const rows = await db.select().from(discoveredCompanies).where(
        and(
          eq(discoveredCompanies.status, 'approved'),
          inArray(discoveredCompanies.discoverySource, scope),
        )
      );

      const existingNames = new Set(this.companies.map(c => c.name.toLowerCase()));
      let added = 0;
      let unreachable = 0;

      for (const row of rows) {
        if (!row.atsId || existingNames.has(row.name.toLowerCase())) {continue;}

        const legacy = this.approvedRowToLegacy(row);
        if (!legacy) {
          // workable / smartrecruiters / breezy / recruitee: scrapeSubset()'s
          // tier filter only selects greenhouse+ashby (1), lever+workday (2)
          // and !ats (3), so these match NO tier. Skipping them beats pushing a
          // config nothing will ever select — and beats career-page-scraper.ts's
          // behaviour of falling back to a bogus boards.greenhouse.io URL.
          unreachable++;
          continue;
        }

        this.companies.push(convertToSOTAConfig(legacy));
        existingNames.add(row.name.toLowerCase());
        added++;
      }

      logger.info(
        `Merged ${added} approved companies from DB (sources: ${scope.join(',')}); ` +
        `${unreachable} skipped — their ATS is not covered by any tier`
      );
    } catch (err: any) {
      // Never let this break a scrape: worst case we run the hardcoded list.
      logger.error(`Failed to merge approved companies: ${err?.message}`);
    }
  }

  /** Map an approved discovered_companies row onto convertToSOTAConfig's input. */
  private approvedRowToLegacy(row: typeof discoveredCompanies.$inferSelect): any | null {
    const id = row.atsId!;
    switch (row.detectedAts) {
      case 'greenhouse':
        return { name: row.name, careerUrl: row.careerPageUrl || `https://boards.greenhouse.io/${id}`, greenhouseId: id };
      case 'ashby':
        return { name: row.name, careerUrl: row.careerPageUrl || `https://jobs.ashbyhq.com/${id}`, ashbyId: id };
      case 'lever':
        return { name: row.name, careerUrl: row.careerPageUrl || `https://jobs.lever.co/${id}`, leverId: id };
      case 'workday':
        // Only usable when we have a real *.myworkdayjobs.com board URL to
        // derive the JSON API from; otherwise it degrades to page scraping,
        // which tier 2 does not select for.
        return row.careerPageUrl?.includes('myworkdayjobs.com')
          ? { name: row.name, careerUrl: row.careerPageUrl, workdayBoardUrl: row.careerPageUrl }
          : null;
      default:
        return null;
    }
  }

  /**
   * Run full scrape of all companies
   */
  async scrapeAll(options?: { signal?: AbortSignal }): Promise<ScrapeResult> {
    await this.mergeApprovedFromDatabase();
    const startTime = Date.now();
    const result: ScrapeResult = {
      success: true,
      companiesScraped: 0,
      totalJobsFound: 0,
      jobsIngested: 0,
      errors: [],
      duration: 0
    };

    try {
      logger.info('Starting SOTA scraper full run');

      const { results, jobs } = await this.orchestrator.scrapeCompanies(this.companies, options?.signal);

      result.companiesScraped = results.length;
      result.totalJobsFound = jobs.length;

      for (const scrapeResult of results) {
        if (scrapeResult.error) {
          result.errors.push(`${scrapeResult.companyName}: ${scrapeResult.error.message}`);
        }
      }

      if (jobs.length > 0) {
        const ingestionInputs = jobs.map(convertToIngestionFormat);
        const ingestionStats = await jobIngestionService.ingestExternalJobs(ingestionInputs);
        result.jobsIngested = ingestionStats.inserted;

        logger.info(`Ingestion complete: ${ingestionStats.inserted} new, ${ingestionStats.duplicates} duplicates, ${ingestionStats.errors} errors`);
      }

      // Mark as failed if >50% of companies failed or no jobs found
      const errorRate = result.errors.length / this.companies.length;
      if (errorRate > 0.5 || result.totalJobsFound === 0) {
        result.success = false;
        logger.error(`SOTA scraper marked as failed: ${(errorRate * 100).toFixed(1)}% error rate, ${result.totalJobsFound} jobs found`);
      }

      result.duration = Date.now() - startTime;
      logger.info(`SOTA scraper complete in ${result.duration}ms`, {
        companiesScraped: result.companiesScraped,
        totalJobsFound: result.totalJobsFound,
        jobsIngested: result.jobsIngested,
        duration: result.duration
      });

    } catch (error) {
      result.success = false;
      result.errors.push(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
      logger.error('SOTA scraper failed', { error });
    }

    return result;
  }

  /**
   * Scrape a subset of companies by tier (for GitHub Actions).
   * Tier 1: Greenhouse companies (API-based, fast)
   * Tier 2: Lever + Workday companies
   * Tier 3: Custom career pages (AI extraction, slowest)
   */
  async scrapeSubset(tier: 1 | 2 | 3, options?: { signal?: AbortSignal }): Promise<ScrapeResult> {
    await this.mergeApprovedFromDatabase();
    const startTime = Date.now();
    const result: ScrapeResult = {
      success: true,
      companiesScraped: 0,
      totalJobsFound: 0,
      jobsIngested: 0,
      errors: [],
      duration: 0
    };

    // Filter companies by tier based on ATS type
    // Tier 1: Greenhouse + Ashby (fast JSON APIs, most reliable)
    // Tier 2: Lever + Workday
    // Tier 3: Custom career pages (AI extraction / Firecrawl, slowest)
    const tierCompanies = this.companies.filter(c => {
      if (tier === 1) {return c.ats?.type === 'greenhouse' || c.ats?.type === 'ashby';}
      if (tier === 2) {return c.ats?.type === 'lever' || c.ats?.type === 'workday';}
      return !c.ats;
    });

    logger.info(`Scraping tier ${tier}: ${tierCompanies.length} companies`);

    try {
      const { results, jobs } = await this.orchestrator.scrapeCompanies(tierCompanies, options?.signal);

      result.companiesScraped = results.length;
      result.totalJobsFound = jobs.length;

      for (const scrapeResult of results) {
        if (scrapeResult.error) {
          result.errors.push(`${scrapeResult.companyName}: ${scrapeResult.error.message}`);
        }
      }

      if (jobs.length > 0) {
        const ingestionInputs = jobs.map(convertToIngestionFormat);
        const ingestionStats = await jobIngestionService.ingestExternalJobs(ingestionInputs);
        result.jobsIngested = ingestionStats.inserted;

        logger.info(`Tier ${tier} ingestion: ${ingestionStats.inserted} new, ${ingestionStats.duplicates} duplicates`);
      }

      // Mark as failed if >50% of companies failed or no jobs found
      const errorRate = result.errors.length / tierCompanies.length;
      if (errorRate > 0.5 || result.totalJobsFound === 0) {
        result.success = false;
        logger.error(`Tier ${tier} marked as failed: ${(errorRate * 100).toFixed(1)}% error rate, ${result.totalJobsFound} jobs found`);
      }

      result.duration = Date.now() - startTime;
      logger.info(`Tier ${tier} complete in ${result.duration}ms`, {
        companiesScraped: result.companiesScraped,
        totalJobsFound: result.totalJobsFound,
        jobsIngested: result.jobsIngested,
      });

    } catch (error) {
      result.success = false;
      result.errors.push(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
      logger.error(`Tier ${tier} scraper failed`, { error });
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * Scrape a specific company (for testing)
   */
  async scrapeCompany(companyId: string): Promise<ScrapeResult> {
    const company = this.companies.find(c => c.id === companyId);
    if (!company) {
      throw new Error(`Company ${companyId} not found`);
    }

    const startTime = Date.now();
    const result: ScrapeResult = {
      success: true,
      companiesScraped: 1,
      totalJobsFound: 0,
      jobsIngested: 0,
      errors: [],
      duration: 0
    };

    try {
      const { results, jobs } = await this.orchestrator.scrapeCompanies([company]);

      result.totalJobsFound = jobs.length;

      const scrapeResult = results[0];
      if (scrapeResult?.error) {
        result.errors.push(`${scrapeResult.companyName}: ${scrapeResult.error.message}`);
      }

      if (jobs.length > 0) {
        const ingestionInputs = jobs.map(convertToIngestionFormat);
        const ingestionStats = await jobIngestionService.ingestExternalJobs(ingestionInputs);
        result.jobsIngested = ingestionStats.inserted;
      }

      result.duration = Date.now() - startTime;

    } catch (error) {
      result.success = false;
      result.errors.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    return result;
  }

  /**
   * Get list of configured companies
   */
  getCompanies(): Array<{ id: string; name: string; priority: string }> {
    return this.companies.map(c => ({
      id: c.id,
      name: c.name,
      priority: c.priority
    }));
  }
}

// Export singleton instance
export const sotaScraperService = new SOTAScraperService();
