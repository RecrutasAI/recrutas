/**
 * Intelligent Deduplication System
 * 
 * Uses multiple strategies to identify duplicate jobs:
 * 1. Exact hash matching
 * 2. Fuzzy string matching on title + company + location
 * 3. Semantic similarity using embeddings (optional)
 * 4. URL normalization and comparison
 */

import { ScrapedJob, DeduplicationConfig, DuplicateGroup } from '../types.js';
import { logger } from '../utils/logger.js';

// Default configuration
const DEFAULT_CONFIG: DeduplicationConfig = {
  useEmbeddings: false, // Disabled by default to avoid extra dependencies
  embeddingThreshold: 0.92,
  exactMatchFields: ['id', 'externalUrl'],
  fuzzyThreshold: 0.85,
  timeWindowHours: 168 // 7 days
};

export class DeduplicationEngine {
  private config: DeduplicationConfig;
  private seenHashes = new Set<string>();
  private jobSignatures = new Map<string, ScrapedJob>();

  constructor(config: Partial<DeduplicationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Deduplicate a list of jobs
   */
  deduplicate(jobs: ScrapedJob[]): { unique: ScrapedJob[]; duplicates: DuplicateGroup[] } {
    const unique: ScrapedJob[] = [];
    const duplicates: DuplicateGroup[] = [];

    for (const job of jobs) {
      const existing = this.findDuplicate(job);
      
      if (existing) {
        // This is a duplicate
        const group = duplicates.find(g => g.canonicalJob.id === existing.id);
        if (group) {
          group.duplicates.push(job);
        } else {
          duplicates.push({
            canonicalJob: existing,
            duplicates: [job],
            confidence: this.calculateSimilarity(job, existing),
            reason: this.getDuplicateReason(job, existing)
          });
        }
      } else {
        // This is unique
        unique.push(job);
        this.addToIndex(job);
      }
    }

    logger.info(`Deduplication complete`, {
      total: jobs.length,
      unique: unique.length,
      duplicates: duplicates.length
    });

    return { unique, duplicates };
  }

  /**
   * Find if a job is a duplicate of an existing one
   */
  private findDuplicate(job: ScrapedJob): ScrapedJob | null {
    // 1. Check exact hash match
    const hash = this.generateHash(job);
    if (this.seenHashes.has(hash)) {
      return this.jobSignatures.get(hash) || null;
    }

    // 2. Check exact URL match
    const normalizedUrl = this.normalizeUrl(job.externalUrl);
    for (const [_, existing] of this.jobSignatures) {
      if (this.normalizeUrl(existing.externalUrl) === normalizedUrl) {
        return existing;
      }
    }

    // 3. Check fuzzy match on title + company + location
    const signature = this.generateSignature(job);
    
    for (const [_, existing] of this.jobSignatures) {
      const existingSignature = this.generateSignature(existing);
      const similarity = this.calculateSimilarity(job, existing);
      
      if (similarity >= this.config.fuzzyThreshold) {
        // Additional checks to avoid false positives
        // Unknown posting dates can't rule a match out.
        const timeDiff = job.postedDate && existing.postedDate
          ? Math.abs(job.postedDate.getTime() - existing.postedDate.getTime()) : 0;
        const timeWindow = this.config.timeWindowHours * 60 * 60 * 1000;
        
        if (timeDiff < timeWindow) {
          return existing;
        }
      }
    }

    return null;
  }

  /**
   * Add a job to the index
   */
  private addToIndex(job: ScrapedJob): void {
    const hash = this.generateHash(job);
    this.seenHashes.add(hash);
    this.jobSignatures.set(hash, job);
  }

  /**
   * Generate a hash for exact matching
   */
  private generateHash(job: ScrapedJob): string {
    const components = [
      job.normalizedTitle || job.title,
      job.company.toLowerCase(),
      job.location.normalized,
      job.employmentType
    ];
    
    return components.join('|');
  }

  /**
   * Generate a signature for fuzzy matching
   */
  private generateSignature(job: ScrapedJob): string {
    const title = (job.normalizedTitle || job.title).toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    const company = job.company.toLowerCase().trim();
    const location = job.location.normalized;
    
    return `${title}|${company}|${location}`;
  }

  /**
   * Calculate similarity between two jobs (0-1)
   */
  private calculateSimilarity(job1: ScrapedJob, job2: ScrapedJob): number {
    const sig1 = this.generateSignature(job1);
    const sig2 = this.generateSignature(job2);
    
    // Use Levenshtein distance for string similarity
    const distance = this.levenshteinDistance(sig1, sig2);
    const maxLength = Math.max(sig1.length, sig2.length);
    
    return 1 - (distance / maxLength);
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];
    
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  /**
   * Normalize URL for comparison
   */
  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      
      // Remove tracking parameters
      const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source'];
      trackingParams.forEach(param => parsed.searchParams.delete(param));
      
      // Remove trailing slash
      let normalized = parsed.toString().replace(/\/$/, '');
      
      // Normalize www
      normalized = normalized.replace(/www\./, '');
      
      return normalized.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }

  /**
   * Get the reason for duplicate detection
   */
  private getDuplicateReason(job1: ScrapedJob, job2: ScrapedJob): string {
    if (this.normalizeUrl(job1.externalUrl) === this.normalizeUrl(job2.externalUrl)) {
      return 'url_match';
    }
    
    const similarity = this.calculateSimilarity(job1, job2);
    if (similarity >= this.config.fuzzyThreshold) {
      return 'fuzzy_match';
    }
    
    return 'unknown';
  }

  /**
   * Clear the deduplication index
   */
  clear(): void {
    this.seenHashes.clear();
    this.jobSignatures.clear();
    logger.info('Deduplication index cleared');
  }

  /**
   * Get current index size
   */
  getIndexSize(): number {
    return this.jobSignatures.size;
  }
}

// Singleton instance
export const deduplicationEngine = new DeduplicationEngine();
