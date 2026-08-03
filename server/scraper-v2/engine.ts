/**
 * SOTA Scraper Engine
 *
 * Core scraping orchestrator that implements multiple extraction strategies
 * and intelligently selects the best method for each company.
 */

import {
  ScrapedJob,
  CompanyConfig,
  ScrapingResult,
  ScrapingError,
  ScrapeMethod,
} from './types.js';
import { RateLimiter } from './utils/rate-limiter.js';
import { AntiDetection } from './utils/anti-detection.js';
import { logger } from './utils/logger.js';
import { extractJsonLdJobs } from './strategies/json-ld.js';
import { extractHtmlJobs } from './strategies/html-parsing.js';
import { extractWithAI } from './strategies/ai-extraction.js';
import { fetchFromATS } from './strategies/ats-apis.js';
import { extractWithFirecrawl } from './strategies/firecrawl.js';
import { normalizeJob, calculateJobHash } from './utils/normalization.js';

export interface ScraperEngineConfig {
  maxConcurrent: number;
  batchSize: number;
  requestTimeout: number;
  totalTimeout: number;
  maxRetries: number;
  retryDelay: number;
  enableAI: boolean;
  globalRateLimit: {
    requestsPerMinute: number;
    burstSize: number;
  };
}

const DEFAULT_CONFIG: ScraperEngineConfig = {
  maxConcurrent: 10,
  batchSize: 5,
  requestTimeout: 30000,
  totalTimeout: 120000,
  maxRetries: 3,
  retryDelay: 1000,
  enableAI: true,
  globalRateLimit: {
    requestsPerMinute: 60,
    burstSize: 10
  }
};

export class ScraperEngine {
  private config: ScraperEngineConfig;
  private rateLimiter: RateLimiter;
  private antiDetection: AntiDetection;

  constructor(config: Partial<ScraperEngineConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      globalRateLimit: { ...DEFAULT_CONFIG.globalRateLimit, ...config.globalRateLimit },
    };
    this.rateLimiter = new RateLimiter(this.config.globalRateLimit);
    this.antiDetection = new AntiDetection();
  }

  /**
   * Scrape a single company using the optimal strategy
   */
  async scrapeCompany(company: CompanyConfig, signal?: AbortSignal): Promise<ScrapingResult> {
    const startTime = Date.now();

    try {
      logger.info(`Starting scrape for ${company.name}`, { companyId: company.id });

      const strategies = company.scrapeConfig.strategies;
      let lastError: ScrapingError | undefined;
      let jobs: ScrapedJob[] = [];
      let successfulMethod: ScrapeMethod | undefined;

      for (const method of strategies) {
        if (signal?.aborted) {break;}

        try {
          jobs = await this.executeStrategy(method, company, signal);

          if (jobs.length > 0) {
            successfulMethod = method;
            logger.info(`Successfully scraped ${company.name} using ${method}`, {
              companyId: company.id,
              jobCount: jobs.length,
              method
            });
            break;
          }
        } catch (error) {
          lastError = this.createError(error);
          logger.warn(`Strategy ${method} failed for ${company.name}`, {
            companyId: company.id,
            error: lastError
          });

          if (lastError.type === 'blocked' || lastError.type === 'rate_limit') {
            break;
          }
        }
      }

      const processedJobs = await this.processJobs(jobs, company);
      const duration = Date.now() - startTime;
      const successCount = processedJobs.length > 0 ? 1 : 0;

      return {
        companyId: company.id,
        companyName: company.name,
        success: processedJobs.length > 0,
        jobs: processedJobs,
        newJobs: processedJobs.filter(j => j.status === 'active').length,
        updatedJobs: 0,
        removedJobs: 0,
        duration,
        timestamp: new Date(),
        method: successfulMethod || 'html_parsing',
        error: processedJobs.length === 0 ? lastError : undefined,
        metadata: {
          pagesScraped: 1,
          requestsMade: strategies.length,
          bytesDownloaded: 0,
          rateLimited: lastError?.type === 'rate_limit'
        }
      };

    } catch (error) {
      const duration = Date.now() - startTime;

      return {
        companyId: company.id,
        companyName: company.name,
        success: false,
        jobs: [],
        newJobs: 0,
        updatedJobs: 0,
        removedJobs: 0,
        duration,
        timestamp: new Date(),
        method: 'html_parsing',
        error: this.createError(error),
        metadata: {
          pagesScraped: 0,
          requestsMade: 0,
          bytesDownloaded: 0,
          rateLimited: false
        }
      };
    }
  }

  /**
   * Execute a specific scraping strategy
   */
  private async executeStrategy(
    method: ScrapeMethod,
    company: CompanyConfig,
    signal?: AbortSignal
  ): Promise<ScrapedJob[]> {
    await this.rateLimiter.acquire(company.id);

    const fetchOptions = this.getFetchOptions(company, signal);

    switch (method) {
      case 'api':
        if (company.ats) {
          return await fetchFromATS(company, fetchOptions);
        }
        throw new Error('API strategy requires ATS configuration');

      case 'json_ld':
        return await extractJsonLdJobs(company, fetchOptions);

      case 'html_parsing':
        return await extractHtmlJobs(company, fetchOptions);

      case 'ai_extraction':
        if (!this.config.enableAI) {
          throw new Error('AI extraction is disabled');
        }
        return await extractWithAI(company, fetchOptions);

      case 'firecrawl':
        return await extractWithFirecrawl(company, fetchOptions);

      default:
        throw new Error(`Unknown strategy: ${method}`);
    }
  }

  /**
   * Get fetch options with anti-detection measures and signal
   */
  private getFetchOptions(company: CompanyConfig, signal?: AbortSignal): RequestInit {
    const headers = this.antiDetection.getHeaders(company.careerPageUrl);
    const timeoutSignal = AbortSignal.timeout(this.config.requestTimeout);

    // Combine the external signal (from cron timeout) with the per-request timeout
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    return {
      headers,
      signal: combinedSignal,
    };
  }

  /**
   * Process and normalize scraped jobs
   */
  private async processJobs(jobs: ScrapedJob[], company: CompanyConfig): Promise<ScrapedJob[]> {
    const processed: ScrapedJob[] = [];

    for (const job of jobs) {
      try {
        const normalized = await normalizeJob(job, company);
        normalized.id = calculateJobHash(normalized);
        normalized.source = {
          type: 'career_page',
          company: company.name,
          url: company.careerPageUrl,
          ats: company.ats?.type,
          scrapeMethod: 'html_parsing'
        };
        processed.push(normalized);
      } catch (error) {
        logger.warn(`Failed to process job from ${company.name}`, { error });
      }
    }

    return processed;
  }

  /**
   * Scrape multiple companies in parallel with rate limiting
   */
  async scrapeCompanies(companies: CompanyConfig[], signal?: AbortSignal): Promise<ScrapingResult[]> {
    const results: ScrapingResult[] = [];

    for (let i = 0; i < companies.length; i += this.config.batchSize) {
      if (signal?.aborted) {break;}

      const batch = companies.slice(i, i + this.config.batchSize);

      logger.info(`Processing batch ${Math.floor(i / this.config.batchSize) + 1}`, {
        batchSize: batch.length,
        totalCompanies: companies.length
      });

      // Race the batch against the abort signal. Checking `signal.aborted` only
      // between batches is not enough: if a company stalls inside the batch, the
      // allSettled never resolves and the abort is inert, so the caller's timeout
      // passes silently and the run burns until something SIGKILLs it. Partial
      // results collected so far are still returned.
      const batchPromise = Promise.allSettled(
        batch.map(company => this.scrapeCompany(company, signal))
      );

      let batchResults: PromiseSettledResult<ScrapingResult>[];
      try {
        batchResults = await this.raceAbort(batchPromise, signal);
      } catch {
        logger.warn('Scrape aborted mid-batch — returning partial results', {
          companiesCompleted: results.length,
          totalCompanies: companies.length,
        });
        break;
      }

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          logger.error('Batch scrape failed', { error: result.reason });
        }
      }

      if (i + this.config.batchSize < companies.length) {
        await this.delay(1000);
      }
    }

    return results;
  }

  /**
   * Resolve with `work`, or reject as soon as `signal` aborts — whichever first.
   * Without a signal the work is simply awaited. The abort listener is removed on
   * settle so a long run does not accumulate one per batch.
   */
  private raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {return work;}
    if (signal.aborted) {return Promise.reject(new Error('Scrape aborted'));}

    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Scrape aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    });

    return Promise.race([work, aborted]).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  }

  private createError(error: unknown): ScrapingError {
    const message = error instanceof Error ? error.message : String(error);

    let type: ScrapingError['type'] = 'unknown';
    let retryable = true;

    if (message.includes('rate limit') || message.includes('429')) {
      type = 'rate_limit';
    } else if (message.includes('blocked') || message.includes('403') || message.includes('captcha')) {
      type = 'blocked';
      retryable = false;
    } else if (message.includes('timeout') || message.includes('aborted')) {
      type = 'timeout';
    } else if (message.includes('parse') || message.includes('JSON')) {
      type = 'parse';
      retryable = false;
    } else if (message.includes('network') || message.includes('fetch')) {
      type = 'network';
    }

    return { type, message, retryable, timestamp: new Date() };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
