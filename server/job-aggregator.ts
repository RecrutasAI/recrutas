import { weWorkRemotelyService } from './services/we-work-remotely.service';
import { getProfessions, getProfession, detectProfession, ProfessionConfig } from './config/professions';
import { SKILL_ALIASES } from './skill-normalizer';
import { getCareersUrl } from './lib/company-careers-url';
import { resolveAdzunaLink } from './lib/adzuna-link-resolver';

// Aggregator sources whose URLs go through the link resolver post-merge.
// Resolved jobs get rewritten source/URL and become feed-eligible. Unresolved
// jobs keep their aggregator source — they're filtered out of the feed but
// still mined for company names by the discovery pipeline.
const AGGREGATOR_SOURCES_TO_RESOLVE = new Set([
  'Adzuna', 'The Muse', 'JSearch', 'Jooble', 'Indeed',
  'ArbeitNow', 'USAJobs', 'RemoteOK', 'WeWorkRemotely',
]);

// Trust scores for different job sources (0-100)
// Higher scores indicate more trustworthy/verified sources
export const SOURCE_TRUST_SCORES: Record<string, number> = {
  'platform': 100,          // Internal platform jobs - most trustworthy
  'career_page': 90,        // Direct from employer via official ATS API - highest external trust
  'external': 85,           // Career-page scraped (AI/HTML fallback) - direct employer URLs
  'WeWorkRemotely': 80,     // Curated remote jobs with direct URLs - HIGH QUALITY
  'JSearch': 75,            // JSearch API - aggregates real jobs
  'Adzuna': 72,             // Large UK/US aggregator, wide industry coverage
  'The Muse': 70,           // Curated tech jobs from real companies
  'Jooble': 65,             // Global aggregator, wide industry coverage
  'RemoteOK': 65,           // Remote-focused jobs, generally accurate
  'ArbeitNow': 60,          // European job board aggregator
  'default': 50             // Default for unknown sources
};

// Get trust score for a source, with fallback
export function getSourceTrustScore(source: string): number {
  return SOURCE_TRUST_SCORES[source] ?? SOURCE_TRUST_SCORES['default'];
}

// Trust badge thresholds
export const TRUST_BADGES = {
  VERIFIED_ACTIVE: 90,      // Show "Verified Active" badge
  DIRECT_FROM_COMPANY: 85,  // Show "Direct from Company" badge
  HIGH_TRUST: 70,           // Show as trusted source
  MEDIUM_TRUST: 50,         // Standard display
  LOW_TRUST: 30             // Show caution indicator
};

interface ExternalJob {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string;
  requirements: string[];
  skills: string[];
  workType: string;
  salaryMin?: number;
  salaryMax?: number;
  source: string;
  externalUrl: string;
  careerPageUrl?: string;
  postedDate: string;
  // Trust-related fields
  trustScore?: number;
  isVerifiedActive?: boolean;
  lastLivenessCheck?: string;
  // Profession classification
  profession?: string;
  // Resolution info for tracking
  resolvedVia?: string;
}

interface JSearchJob {
  job_id: string;
  job_title: string;
  employer_name: string;
  job_city?: string;
  job_state?: string;
  job_country?: string;
  job_description: string;
  job_highlights?: {
    Qualifications?: string[];
    Responsibilities?: string[];
  };
  job_is_remote: boolean;
  job_min_salary?: number;
  job_max_salary?: number;
  job_apply_link?: string;
  job_google_link?: string;
  job_posted_at_datetime_utc?: string;
}

interface JSearchApiResponse {
  data?: JSearchJob[];
}

interface RemoteOKJob {
  id: string;
  position: string;
  company: string;
  location?: string;
  description?: string;
  tags?: string[];
  salary_min?: number;
  salary_max?: number;
  url: string;
  date: string;
}

interface MuseJob {
  id: string;
  name: string;
  company?: {
    name: string;
  };
  locations?: {
    name: string;
  }[];
  contents: string;
  refs?: {
    landing_page: string;
  };
  publication_date: string;
}

interface MuseApiResponse {
  results?: MuseJob[];
}

interface USAJobsJob {
  PositionID: string;
  PositionTitle: string;
  OrganizationName: string;
  PositionLocationDisplay: string;
  QualificationSummary: string;
  PositionSummary: string;
  PositionRemuneration: {
    MinimumRange: number;
    MaximumRange: number;
  }[];
  PositionURI: string;
  PublicationStartDate: string;
}

interface USAJobsApiResponse {
  SearchResult?: {
    SearchResultItems?: USAJobsJob[];
  };
}

interface JoobleJob {
  title: string;
  company: string;
  location: string;
  snippet: string;
  type: string;
  salary?: string;
  link: string;
  updated: string;
}

interface JoobleApiResponse {
  jobs?: JoobleJob[];
}

interface ArbeitNowJob {
  slug: string;
  title: string;
  company_name: string;
  location: string;
  description: string;
  tags: string[];
  remote: boolean;
  url: string;
  created_at: string;
}

interface ArbeitNowApiResponse {
  data?: ArbeitNowJob[];
}

interface AdzunaJob {
  id: string;
  title: string;
  company: {
    display_name: string;
  };
  location: {
    display_name: string;
  };
  description: string;
  redirect_url: string;
  created: string;
  salary_min?: number;
  salary_max?: number;
  contract_type?: string;
  category?: {
    label: string;
  };
}

interface AdzunaApiResponse {
  results?: AdzunaJob[];
}

export class JobAggregator {

  // Fetch with exponential backoff retry on 429/503
  private async fetchWithRetry(url: string, options?: RequestInit, maxRetries = 3): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await fetch(url, options);
      if (response.status !== 429 && response.status !== 503) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError!;
  }

  // Add new open source job sources
  async fetchFromJSearchAPI(userSkills?: string[]): Promise<ExternalJob[]> {
    try {
      console.log('Fetching from JSearch API...');

      // Wide industry queries — same breadth as Adzuna/Jooble
      const queries = [
        'software engineer', 'data analyst', 'product manager',
        'IT support', 'cybersecurity', 'nurse',
        'accountant', 'marketing manager', 'sales representative',
        'project manager', 'customer service', 'human resources',
      ];

      // Prepend user skills if available
      if (userSkills && userSkills.length > 0) {
        queries.unshift(...userSkills.slice(0, 3));
      }

      const allJobs: ExternalJob[] = [];
      const seen = new Set<string>();

      for (const query of queries) {
        if (allJobs.length >= 500) break;
        try {
          const params = new URLSearchParams({
            query,
            page: '1',
            num_pages: '5',
            country: 'US',
            employment_types: 'FULLTIME,PARTTIME,CONTRACTOR',
            job_requirements: 'under_3_years_experience,more_than_3_years_experience,no_experience',
            remote_jobs_only: 'false'
          });

          const response = await this.fetchWithRetry(`https://jsearch.p.rapidapi.com/search?${params}`, {
            headers: {
              'X-RapidAPI-Key': process.env.RAPIDAPI_KEY || '',
              'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
              'User-Agent': 'JobPlatform/1.0'
            }
          });

          if (response.ok) {
            const data: JSearchApiResponse = await response.json();
            for (const job of this.transformJSearchJobs(data.data || [])) {
              const key = `${job.title}::${job.company}`.toLowerCase();
              if (!seen.has(key)) {
                seen.add(key);
                allJobs.push(job);
              }
            }
          }

          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
          console.log(`[JSearch] Skipping query "${query}":`, (error as Error).message);
        }
      }

      console.log(`[JSearch] Fetched ${allJobs.length} jobs across ${queries.length} queries`);
      return allJobs;
    } catch (error) {
      console.log('Error fetching from JSearch:', (error as Error).message);
      return [];
    }
  }

  async fetchFromArbeitNow(): Promise<ExternalJob[]> {
    try {
      console.log('Fetching from ArbeitNow (free European jobs)...');

      const response = await this.fetchWithRetry('https://www.arbeitnow.com/api/job-board-api', {
        headers: {
          'User-Agent': 'JobPlatform/1.0',
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const data: ArbeitNowApiResponse = await response.json();
        const jobs = this.transformArbeitNowJobs(data.data || []);
        console.log(`Fetched ${jobs.length} real jobs from ArbeitNow`);
        return jobs;
      } else {
        console.log(`ArbeitNow API returned ${response.status}`);
        return [];
      }
    } catch (error) {
      console.log('Error fetching from ArbeitNow:', (error as Error).message);
      return [];
    }
  }

  async fetchFromJoobleAPI(userSkills?: string[]): Promise<ExternalJob[]> {
    try {
      const apiKey = process.env.JOOBLE_API_KEY;
      if (!apiKey) {
        console.log('[Jooble] JOOBLE_API_KEY not set — skipping');
        return [];
      }

      // Wide industry search queries
      const searchQueries = [
        'software engineer', 'data analyst', 'IT support',
        'network administrator', 'cybersecurity analyst',
        'nurse', 'medical technician', 'healthcare',
        'accountant', 'financial analyst', 'marketing manager',
        'project manager', 'human resources', 'operations manager',
        'sales representative', 'customer service', 'supply chain',
        'teacher', 'social worker', 'graphic designer',
      ];

      // Prepend user skills if available
      if (userSkills && userSkills.length > 0) {
        searchQueries.unshift(...userSkills.slice(0, 3));
      }

      const allJobs: ExternalJob[] = [];
      const seen = new Set<string>();

      for (const keywords of searchQueries) {
        if (allJobs.length >= 500) break;
        try {
          const response = await this.fetchWithRetry(`https://jooble.org/api/${apiKey}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'RecrutasJobAggregator/1.0'
            },
            body: JSON.stringify({
              keywords,
              location: 'USA',
              page: 1,
              ResultOnPage: 50,
            }),
          });

          if (response.ok) {
            const data: JoobleApiResponse = await response.json();
            for (const job of this.transformJoobleJobs(data.jobs || [])) {
              const key = `${job.title}::${job.company}`.toLowerCase();
              if (!seen.has(key)) {
                seen.add(key);
                allJobs.push(job);
              }
            }
          }

          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
          console.log(`[Jooble] Skipping query "${keywords}":`, (error as Error).message);
        }
      }

      console.log(`[Jooble] Fetched ${allJobs.length} jobs across ${searchQueries.length} queries`);
      return allJobs;
    } catch (error) {
      console.log('[Jooble] Error:', (error as Error).message);
      return [];
    }
  }

  async fetchFromIndeedRSS(userSkills?: string[]): Promise<ExternalJob[]> {
    try {
      console.log('Fetching from Indeed RSS feeds...');

      const query = userSkills && userSkills.length > 0
        ? userSkills.join('+')
        : 'software+developer';

      const response = await this.fetchWithRetry(`https://www.indeed.com/rss?q=${query}&l=&sort=date`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; JobBot/1.0)',
          'Accept': 'application/rss+xml, application/xml'
        }
      });

      if (response.ok) {
        const xmlText = await response.text();
        const jobs = this.parseIndeedRSS(xmlText);
        console.log(`Fetched ${jobs.length} real jobs from Indeed RSS`);
        return jobs;
      } else {
        console.log(`Indeed RSS returned ${response.status}`);
        return [];
      }
    } catch (error) {
      console.log('Error fetching from Indeed RSS:', (error as Error).message);
      return [];
    }
  }

  async fetchFromUSAJobs(userSkills?: string[]): Promise<ExternalJob[]> {
    try {
      console.log('Fetching from USAJobs.gov API...');

      const queries = [
        'software engineer', 'data analyst', 'IT specialist',
        'cybersecurity', 'network administrator', 'project manager',
        'nurse', 'healthcare', 'accountant',
        'human resources', 'administrative', 'logistics',
        'contract specialist', 'management analyst', 'program analyst',
      ];

      if (userSkills && userSkills.length > 0) {
        queries.unshift(...userSkills.slice(0, 3));
      }

      const allJobs: ExternalJob[] = [];
      const seen = new Set<string>();

      for (const keyword of queries) {
        if (allJobs.length >= 500) break;
        try {
          const params = new URLSearchParams({
            Keyword: keyword,
            LocationName: 'United States',
            ResultsPerPage: '50',
            WhoMayApply: 'All',
            SortField: 'PublicationStartDate',
            SortDirection: 'Descending'
          });

          const response = await this.fetchWithRetry(`https://data.usajobs.gov/api/search?${params}`, {
            headers: {
              'Host': 'data.usajobs.gov',
              'User-Agent': 'Recrutas-Platform/1.0 (hello@recrutas.ai)',
              'Authorization-Key': process.env.USAJOBS_API_KEY || ''
            }
          });

          if (response.ok) {
            const data: USAJobsApiResponse = await response.json();
            for (const job of this.transformUSAJobs(data.SearchResult?.SearchResultItems || [])) {
              const key = `${job.title}::${job.company}`.toLowerCase();
              if (!seen.has(key)) {
                seen.add(key);
                allJobs.push(job);
              }
            }
          }

          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
          console.log(`[USAJobs] Skipping query "${keyword}":`, (error as Error).message);
        }
      }

      console.log(`[USAJobs] Fetched ${allJobs.length} jobs across ${queries.length} queries`);
      return allJobs;
    } catch (error) {
      console.error('[USAJobs] Error:', error);
      return [];
    }
  }

  // Legacy JSearch endpoint — delegates to the expanded fetchFromJSearchAPI
  async fetchFromJSearch(): Promise<ExternalJob[]> {
    return this.fetchFromJSearchAPI();
  }


  private extractRequirements(text: string): string[] {
    if (!text) {return [];}

    const requirements: string[] = [];
    const lines = text.split('\n').map(line => line.trim());

    for (const line of lines) {
      if (line.includes('require') || line.includes('must have') || line.includes('need')) {
        requirements.push(line);
      }
    }

    return requirements.slice(0, 5); // Limit to 5 requirements
  }

  private extractSkills(skillsData: any): string[] {
    if (Array.isArray(skillsData)) {
      // Normalize each tag/skill through SKILL_ALIASES so they match candidate skills
      const normalized = new Set<string>();
      for (const item of skillsData) {
        const key = String(item).toLowerCase().trim();
        const canonical = SKILL_ALIASES[key];
        if (canonical) {normalized.add(canonical);}
        else if (key.length > 1) {normalized.add(item);} // keep raw if not in aliases
      }
      return Array.from(normalized).slice(0, 15);
    }

    if (typeof skillsData === 'string' && skillsData.length > 0) {
      // N-gram scan against full SKILL_ALIASES (same approach as Skill Intelligence Engine)
      const text = skillsData.toLowerCase();
      const words = skillsData.split(/[\s,;|•·()[\]{}<>]+/).filter(w => w.length > 0);
      const found = new Set<string>();

      for (let i = 0; i < words.length; i++) {
        for (let n = 1; n <= 4 && i + n <= words.length; n++) {
          const phrase = words.slice(i, i + n).join(' ').toLowerCase();
          const canonical = SKILL_ALIASES[phrase];
          if (canonical) {found.add(canonical);}
        }
      }

      return Array.from(found).slice(0, 15);
    }

    return [];
  }

  private normalizeWorkType(workTypeData: any): string {
    const workTypeStr = String(workTypeData).toLowerCase();

    if (workTypeStr.includes('remote') || workTypeStr === 'true') {
      return 'remote';
    } else if (workTypeStr.includes('hybrid')) {
      return 'hybrid';
    } else {
      return 'onsite';
    }
  }

  private transformGitHubJobs(jobs: any[]): ExternalJob[] {
    return jobs.map(job => ({
      id: `github_${job.id}`,
      title: job.title,
      company: job.company,
      location: job.location,
      description: job.description,
      requirements: this.extractRequirements(job.description),
      skills: this.extractSkills(job.title + ' ' + job.description),
      workType: this.normalizeWorkType(job.type),
      salaryMin: undefined,
      salaryMax: undefined,
      source: 'GitHub Jobs',
      externalUrl: job.url,
      postedDate: job.created_at,
    }));
  }

  private transformRemoteOKJobs(jobs: any[]): ExternalJob[] {
    return jobs.map(job => ({
      id: `remoteok_${job.id}`,
      title: job.position,
      company: job.company,
      location: job.location || 'Remote',
      description: job.description || '',
      requirements: this.extractRequirements(job.description || ''),
      skills: this.extractSkills(job.description || ''),
      workType: 'remote',
      salaryMin: job.salary_min,
      salaryMax: job.salary_max,
      source: 'RemoteOK',
      externalUrl: job.url,
      postedDate: new Date(job.date).toISOString(),
      trustScore: getSourceTrustScore('RemoteOK')
    }));
  }

  private transformWeWorkRemotelyJobs(jobs: any[]): ExternalJob[] {
    return jobs.map(job => ({
      id: job.id,
      title: job.title,
      company: job.company,
      location: 'Remote',
      description: job.description,
      requirements: this.extractRequirements(job.description),
      skills: this.extractSkills(job.description),
      workType: 'remote',
      salaryMin: undefined,
      salaryMax: undefined,
      source: 'WeWorkRemotely',
      externalUrl: job.url,
      postedDate: job.publicationDate,
      trustScore: getSourceTrustScore('WeWorkRemotely')
    }));
  }

  private transformAdzunaJobs(jobs: AdzunaJob[]): ExternalJob[] {
    return jobs.map(job => ({
      id: `adzuna_${job.id}`,
      title: job.title,
      company: job.company.display_name,
      location: job.location.display_name,
      description: job.description,
      requirements: [],
      skills: [],
      workType: 'onsite',
      salaryMin: job.salary_min ? Math.round(job.salary_min) : undefined,
      salaryMax: job.salary_max ? Math.round(job.salary_max) : undefined,
      source: 'Adzuna',
      externalUrl: job.redirect_url,
      postedDate: job.created,
      trustScore: getSourceTrustScore('Adzuna'),
    }));
  }

  private async resolveAdzunaUrl(redirectUrl: string, company: string): Promise<string | null> {
    const ATS_DOMAINS = [
      'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'workday.com',
      'smartrecruiters.com', 'ashbyhq.com', 'jobvite.com', 'icims.com',
      'taleo.net', 'bamboohr.com', 'paylocity.com', 'applytojob.com',
      'paycom.com', 'ultipro.com', 'successfactors.com', 'recruitee.com',
      'workable.com', 'breezy.hr', 'pinpointhq.com', 'dover.com',
    ];
    const AGGREGATOR_DOMAINS = [
      'adzuna', 'indeed', 'linkedin', 'glassdoor', 'ziprecruiter', 'monster',
      'simplyhired', 'careerbuilder', 'jobcase', 'jooble', 'dice',
      'talent.com', 'snagajob', 'tealhq.com', 'simplify.jobs', 'wellfound.com',
    ];
    const STOPWORDS = new Set(['the','and','of','in','at','for','a','an','to','inc','llc','corp','co','ltd']);

    const isATS = (u: string) => ATS_DOMAINS.some(d => u.toLowerCase().includes(d));
    const isAggregator = (u: string) => AGGREGATOR_DOMAINS.some(d => u.toLowerCase().includes(d));
    const isSpecificPath = (u: string) => {
      try { return new URL(u).pathname.split('/').filter(Boolean).length >= 2; } catch { return false; }
    };
    const matchesCompany = (u: string) => {
      if (isATS(u)) return true;
      try {
        const domain = new URL(u).hostname.replace(/^www\./, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const tokens = company.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
          .filter(t => t.length >= 4 && !STOPWORDS.has(t));
        return tokens.some(t => domain.includes(t));
      } catch { return false; }
    };

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(redirectUrl, { redirect: 'follow', signal: ctrl.signal });
      clearTimeout(timer);
      const finalUrl = res.url;
      if (!isAggregator(finalUrl) && isSpecificPath(finalUrl) && matchesCompany(finalUrl)) {
        return finalUrl;
      }
    } catch { /* network error — fall through */ }
    return null;
  }

  private transformUSAJobs(jobs: any[]): ExternalJob[] {
    return jobs.filter(item => item && item.MatchedObjectDescriptor).map((item: any) => {
      const job = item.MatchedObjectDescriptor;
      return {
        id: `usa_${job.PositionID}`,
        title: job.PositionTitle,
        company: job.OrganizationName,
        location: job.PositionLocationDisplay,
        description: job.QualificationSummary || job.PositionSummary || '',
        requirements: this.extractRequirements(job.QualificationSummary || ''),
        skills: this.extractSkills(job.PositionTitle + ' ' + (job.QualificationSummary || '')),
        workType: 'onsite',
        salaryMin: job.PositionRemuneration?.[0]?.MinimumRange,
        salaryMax: job.PositionRemuneration?.[0]?.MaximumRange,
        source: 'USAJobs',
        externalUrl: job.PositionURI,
        postedDate: job.PublicationStartDate,
        trustScore: getSourceTrustScore('USAJobs')
      };
    });
  }

  private transformJSearchJobs(jobs: any[]): ExternalJob[] {
    return jobs
      .filter(job => {
        const url = job.job_apply_link || job.job_google_link;
        return url && url !== '#' && this.isValidURL(url);
      })
      .map((job, index) => ({
        id: `jsearch_${job.job_id || index}`,
        title: job.job_title || 'Software Developer',
        company: job.employer_name || 'Tech Company',
        location: job.job_city && job.job_state ? `${job.job_city}, ${job.job_state}` : job.job_country || 'Remote',
        description: job.job_description || job.job_highlights?.Qualifications?.join('. ') || 'Join our team',
        requirements: job.job_highlights?.Responsibilities || [job.job_title],
        skills: this.extractSkillsFromText(job.job_description || job.job_title),
        workType: job.job_is_remote ? 'remote' : 'onsite',
        salaryMin: job.job_min_salary,
        salaryMax: job.job_max_salary,
        source: 'JSearch',
        externalUrl: job.job_apply_link || job.job_google_link,
        postedDate: job.job_posted_at_datetime_utc || new Date().toISOString(),
        trustScore: getSourceTrustScore('JSearch')
      }));
  }


  // Transformation methods for new job sources

  private transformArbeitNowJobs(jobs: any[]): ExternalJob[] {
    return jobs
      .filter(job => job.url && job.url !== '#' && this.isValidURL(job.url))
      .map((job, index) => ({
        id: `arbeitnow_${job.slug || index}`,
        title: job.title || 'Developer Position',
        company: job.company_name || 'European Company',
        location: job.location || 'Europe',
        description: job.description || job.title,
        requirements: job.tags || [job.title],
        skills: job.tags || this.extractSkillsFromText(job.title),
        workType: job.remote ? 'remote' : 'onsite',
        source: 'ArbeitNow',
        externalUrl: job.url,
        postedDate: job.created_at || new Date().toISOString(),
        trustScore: getSourceTrustScore('ArbeitNow')
      }));
  }

  private transformJoobleJobs(jobs: any[]): ExternalJob[] {
    return jobs
      .filter(job => job.link && job.link !== '#' && this.isValidURL(job.link))
      .map((job, index) => ({
        id: `jooble_${index}`,
        title: job.title || 'Position Available',
        company: job.company || 'Company',
        location: job.location || 'USA',
        description: job.snippet || job.title,
        requirements: this.extractRequirements(job.snippet || job.title),
        skills: this.extractSkillsFromText(job.snippet || job.title),
        workType: job.type === 'remote' ? 'remote' : 'onsite',
        salaryMin: job.salary ? parseInt(job.salary.replace(/[^0-9]/g, '')) : undefined,
        source: 'Jooble',
        externalUrl: job.link,
        postedDate: job.updated || new Date().toISOString(),
        trustScore: getSourceTrustScore('Jooble')
      }));
  }

  private parseIndeedRSS(xmlText: string): ExternalJob[] {
    const jobs: ExternalJob[] = [];
    const itemRegex = /<item>(.*?)<\/item>/gs;
    const matches = xmlText.match(itemRegex);

    if (matches) {
      matches.slice(0, 20).forEach((item, index) => {
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
        const linkMatch = item.match(/<link>(.*?)<\/link>/);
        const descMatch = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/);
        const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);

        if (titleMatch && linkMatch) {
          const fullTitle = titleMatch[1];
          const titleParts = fullTitle.split(' at ');
          const title = titleParts[0] || fullTitle;
          const company = titleParts[1] || 'Company';

          jobs.push({
            id: `indeed_rss_${index}`,
            title: title.trim(),
            company: company.trim(),
            location: 'Various',
            description: descMatch ? descMatch[1].substring(0, 500) : title,
            requirements: this.extractRequirements(title),
            skills: this.extractSkillsFromText(title),
            workType: 'hybrid',
            source: 'Indeed',
            externalUrl: linkMatch[1],
            postedDate: pubDateMatch ? new Date(pubDateMatch[1]).toISOString() : new Date().toISOString()
          });
        }
      });
    }

    return jobs;
  }

  private extractSkillsFromText(text: string): string[] {
    const commonSkills = [
      'JavaScript', 'Python', 'Java', 'React', 'Node.js', 'TypeScript',
      'Angular', 'Vue', 'SQL', 'MongoDB', 'PostgreSQL', 'AWS', 'Docker',
      'Kubernetes', 'Git', 'HTML', 'CSS', 'Express', 'Django', 'Flask',
      'Spring', 'Bootstrap', 'jQuery', 'PHP', 'Ruby', 'Go', 'Rust', 'C++',
      'C#', '.NET', 'GraphQL', 'REST', 'API', 'DevOps', 'CI/CD', 'Linux',
      'Redis', 'Elasticsearch', 'Machine Learning', 'AI', 'Data Science'
    ];

    return commonSkills.filter(skill => {
      const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?<![a-zA-Z])${escaped}(?![a-zA-Z])`, 'i').test(text);
    }).slice(0, 8);
  }

  async getAllJobs(userSkillsOrOpts?: string[] | { skills?: string[]; profession?: string; limit?: number }, profession?: string, limit?: number): Promise<ExternalJob[]> {
    // Support both old positional args and new options object
    let userSkills: string[] | undefined;
    if (Array.isArray(userSkillsOrOpts)) {
      userSkills = userSkillsOrOpts;
    } else if (userSkillsOrOpts && typeof userSkillsOrOpts === 'object') {
      userSkills = userSkillsOrOpts.skills;
      profession = userSkillsOrOpts.profession;
      limit = userSkillsOrOpts.limit;
    }
    const allJobs: ExternalJob[] = [];

    try {
      console.log(`[JobAggregator] Fetching jobs for skills: ${userSkills?.join(', ') || 'general'}${profession ? `, profession: ${profession}` : ''}`);

      // Determine which sources to use based on profession
      const professionConfig = profession ? getProfession(profession) : undefined;
      const sourcesToUse = professionConfig?.sources || ['jsearch', 'weworkremotely', 'remoteok', 'themuse'];
      
      console.log(`[JobAggregator] Using sources: ${sourcesToUse.join(', ')}`);

      // Build fetch promises based on profession
      const fetchPromises: Promise<ExternalJob[]>[] = [];
      
      // Always fetch from We Work Remotely (high quality, includes non-tech)
      if (sourcesToUse.includes('weworkremotely') || sourcesToUse.includes('remoteok')) {
        fetchPromises.push(this.fetchWeWorkRemotelyJobs(profession));
      }
      
      // JSearch for general coverage
      if (sourcesToUse.includes('jsearch')) {
        fetchPromises.push(this.fetchFromJSearchAPI(userSkills));
      }
      
      // The Muse for tech/design
      if (sourcesToUse.includes('themuse')) {
        fetchPromises.push(this.fetchFromTheMuse());
      }
      
      // RemoteOK as backup
      if (sourcesToUse.includes('remoteok')) {
        fetchPromises.push(this.fetchRemoteOKJobs());
      }
      
      // USAJobs for non-tech (government jobs) — check source list or profession category
      const usajobsCategories = ['Healthcare', 'Legal', 'Education', 'Trades', 'Business'];
      const needsUsajobs = sourcesToUse.includes('usajobs') ||
        (professionConfig && usajobsCategories.includes(professionConfig.category));
      if (needsUsajobs) {
        fetchPromises.push(this.fetchFromUSAJobs(userSkills));
      }

      // Adzuna — wide industry coverage (tech, IT, healthcare, finance, etc.)
      if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) {
        fetchPromises.push(this.fetchFromAdzuna(userSkills));
      }

      // Jooble — global aggregator, wide industry coverage
      if (process.env.JOOBLE_API_KEY) {
        fetchPromises.push(this.fetchFromJoobleAPI(userSkills));
      }

      // Execute all fetches with error handling
      const results = await Promise.allSettled(fetchPromises);

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          allJobs.push(...result.value);
        } else {
          console.error(`[JobAggregator] Source ${index} failed:`, result.reason);
        }
      });

      // Filter out LinkedIn and Indeed URLs
      const blockedDomains = ['linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com'];
      let blockedCount = 0;
      const filteredJobs = allJobs.filter(job => {
        const url = job.externalUrl.toLowerCase();
        const isBlocked = blockedDomains.some(domain => url.includes(domain));
        if (isBlocked) {blockedCount++;}
        return !isBlocked;
      });
      if (blockedCount > 0) {
        console.log(`[JobAggregator] Filtered out ${blockedCount} jobs from blocked domains`);
      }

      // For known big tech companies, override with their proper career pages
      // (Adzuna often returns amazon.com/microsoft.com instead of amazon.jobs/careers.microsoft.com)
      const KNOWN_CAREER_PAGES: Record<string, string> = {
        amazon: 'https://www.amazon.jobs/',
        microsoft: 'https://careers.microsoft.com/',
        meta: 'https://www.metacareers.com/',
        google: 'https://careers.google.com/',
        apple: 'https://jobs.apple.com/',
        nvidia: 'https://www.nvidia.com/en-us/about-nvidia/careers/',
      };
      for (const job of filteredJobs) {
        const companyKey = job.company?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
        if (KNOWN_CAREER_PAGES[companyKey]) {
          job.careerPageUrl = KNOWN_CAREER_PAGES[companyKey];
        }
      }

      // Tag jobs with detected profession
      const jobsWithProfession = filteredJobs.map(job => {
        const detectedProfession = detectProfession(job.title, job.description);
        return {
          ...job,
          profession: detectedProfession?.code || profession || 'general'
        };
      });

      console.log(`[JobAggregator] Successfully aggregated ${jobsWithProfession.length} jobs from external sources`);

      // Remove duplicates based on title and company
      const uniqueJobs = jobsWithProfession.filter((job, index, arr) =>
        arr.findIndex(j => j.title === job.title && j.company === job.company) === index
      );

      // Aggregator URL resolution is OFF by default: Adzuna and the other
      // third-party aggregators are kept as-is and mixed together in the feed's
      // aggregator fallback using their native redirect/apply URLs (which click
      // through to the real post). The resolver was low-yield (~22% reached a
      // real deep link) and its homepage fallbacks degraded link quality.
      // Set RESOLVE_AGGREGATOR_URLS=true to re-enable laundering into ATS URLs.
      if (process.env.RESOLVE_AGGREGATOR_URLS === 'true') {
        // Runs after dedup so we don't waste work on duplicate title+company pairs.
        await this.resolveAggregatorJobs(uniqueJobs);
      }

      // Log profession breakdown
      const professionCounts = uniqueJobs.reduce((acc, job) => {
        acc[job.profession] = (acc[job.profession] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      console.log(`[JobAggregator] After deduplication: ${uniqueJobs.length} unique jobs`);
      console.log(`[JobAggregator] Profession breakdown:`, professionCounts);

      return uniqueJobs;
    } catch (error) {
      console.error('[JobAggregator] Error aggregating jobs:', error);
      return [];
    }
  }

  // Run aggregator jobs through the link resolver. Mutates the input array.
  // Resolved jobs get their source/URL/trustScore rewritten so they pass the
  // feed's aggregator-source filter; unresolved jobs are left as-is so the
  // discovery pipeline can still mine their company names.
  private async resolveAggregatorJobs(jobs: ExternalJob[]): Promise<void> {
    const targets = jobs.filter(j => AGGREGATOR_SOURCES_TO_RESOLVE.has(j.source));
    if (targets.length === 0) return;

    console.log(`[JobAggregator] Resolving ${targets.length} aggregator jobs through link resolver...`);

    const concurrency = 24;
    let cursor = 0;
    let resolved = 0;

    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= targets.length) return;
        const job = targets[i];
        const result = await resolveAdzunaLink({
          title: job.title,
          company: job.company,
          location: job.location,
          fallbackUrl: job.externalUrl,
          description: job.description ?? undefined,
        });
        if (result.url && result.url !== job.externalUrl) {
          job.resolvedVia = result.resolvedVia;
          if (result.resolvedVia === 'careers_page') {
            // No specific job posting — point users at the careers page instead of
            // letting them fall through to the Adzuna redirect.
            job.careerPageUrl = result.url;
            job.externalUrl = result.url;
            job.source = 'career_page';
          } else if (result.resolvedVia === 'ats' || result.resolvedVia === 'existing') {
            job.externalUrl = result.url;
            job.source = result.atsType ?? 'career_page';
          } else if (
            result.resolvedVia === 'description' ||
            result.resolvedVia === 'scraped' ||
            result.resolvedVia === 'searxng'
          ) {
            job.externalUrl = result.url;
            job.source = 'career_page';
          }
          job.trustScore = getSourceTrustScore(job.source);
          resolved++;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

    console.log(`[JobAggregator] Resolved ${resolved}/${targets.length} aggregator URLs to direct links`);
  }

  // GitHub Jobs API - completely free, no authentication required
  async fetchGitHubJobs(): Promise<ExternalJob[]> {
    try {
      const queries = ['javascript', 'react', 'node.js', 'python', 'developer'];
      const allJobs: ExternalJob[] = [];

      for (const query of queries) {
        try {
          const url = `https://jobs.github.com/positions.json?description=${encodeURIComponent(query)}&location=remote`;
          const response = await fetch(url);

          if (response.ok) {
            const jobs = await response.json() as any[];
            const transformedJobs = this.transformGitHubJobs(jobs || []);
            allJobs.push(...transformedJobs);
          }

          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.log(`Skipping GitHub query "${query}":`, error);
        }
      }

      console.log(`Fetched ${allJobs.length} real jobs from GitHub`);
      return allJobs;
    } catch (error) {
      console.error('Error fetching from GitHub Jobs:', error);
      return [];
    }
  }

  // RemoteOK API - free, no authentication required
  async fetchRemoteOKJobs(skillTags?: string[]): Promise<ExternalJob[]> {
    try {
      let url = 'https://remoteok.io/api';
      if (skillTags && skillTags.length > 0) {
        const tags = skillTags.slice(0, 3)
          .map(s => s.toLowerCase().replace(/[^a-z0-9]/g, '-'))
          .join(',');
        url = `https://remoteok.io/api?tags=${tags}`;
        console.log(`[RemoteOK] Fetching with tags: ${tags}`);
      }

      const response = await this.fetchWithRetry(url, {
        headers: {
          'User-Agent': 'Recrutas-Platform/1.0'
        }
      });

      if (response.ok) {
        const data = await response.json() as RemoteOKJob[];
        // Skip first item which is legal notice
        const jobs = data.slice(1);
        const transformedJobs = this.transformRemoteOKJobs(jobs || []);

        console.log(`Fetched ${transformedJobs.length} real jobs from RemoteOK`);
        return transformedJobs;
      }
    } catch (error) {
      console.error('Error fetching from RemoteOK:', error);
    }

    return [];
  }

  // We Work Remotely - High quality remote jobs with direct URLs
  // Includes both tech and non-tech (sales, support, marketing, etc.)
  async fetchWeWorkRemotelyJobs(profession?: string): Promise<ExternalJob[]> {
    try {
      console.log(`[JobAggregator] Fetching from We Work Remotely${profession ? ` for profession: ${profession}` : ''}...`);
      
      const jobs = await weWorkRemotelyService.fetchJobs(profession);
      const transformedJobs = this.transformWeWorkRemotelyJobs(jobs);
      
      console.log(`[JobAggregator] Fetched ${transformedJobs.length} jobs from We Work Remotely`);
      return transformedJobs;
    } catch (error) {
      console.error('[JobAggregator] Error fetching from We Work Remotely:', error);
      return [];
    }
  }

  // The Muse API - Free tier with real job data
  async fetchFromTheMuse(): Promise<ExternalJob[]> {
    try {
      const categories = [
        'Software Engineer', 'Data Science', 'Product Management',
        'Marketing', 'Sales', 'Customer Service', 'Design',
        'Finance', 'Human Resources', 'Operations', 'Healthcare',
        'Project Management', 'Business Development', 'Education',
      ];
      const allJobs: ExternalJob[] = [];

      for (const category of categories) {
        if (allJobs.length >= 500) break;
        try {
          const url = `https://www.themuse.com/api/public/jobs?category=${encodeURIComponent(category)}&page=0&level=Senior%20Level&level=Mid%20Level&level=Entry%20Level&location=United%20States`;
          const response = await this.fetchWithRetry(url, {
            headers: {
              'User-Agent': 'Recrutas-Platform/1.0'
            }
          });

          if (response.ok) {
            const data: MuseApiResponse = await response.json();
            const jobs = this.transformMuseJobs(data.results || []);
            allJobs.push(...jobs);
          }

          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
          console.log(`Skipping Muse category "${category}":`, error);
        }
      }

      console.log(`Fetched ${allJobs.length} real jobs from The Muse`);
      return allJobs;
    } catch (error) {
      console.error('Error fetching from The Muse:', error);
      return [];
    }
  }

  // Adzuna API — wide industry coverage (tech, IT, healthcare, finance, etc.)
  async fetchFromAdzuna(userSkills?: string[]): Promise<ExternalJob[]> {
    try {
      const appId = process.env.ADZUNA_APP_ID;
      const appKey = process.env.ADZUNA_APP_KEY;
      if (!appId || !appKey) {
        console.log('[Adzuna] ADZUNA_APP_ID/ADZUNA_APP_KEY not set — skipping');
        return [];
      }

      // Wide variety of job queries across industries
      const queries = [
        'software engineer', 'data analyst', 'product manager',
        'IT support', 'network administrator', 'cybersecurity',
        'nurse', 'medical technician', 'healthcare',
        'accountant', 'financial analyst', 'marketing manager',
        'project manager', 'human resources', 'operations manager',
        'sales representative', 'customer service', 'supply chain',
      ];

      // If user has skills, prepend targeted queries
      if (userSkills && userSkills.length > 0) {
        queries.unshift(...userSkills.slice(0, 3));
      }

      const allJobs: ExternalJob[] = [];
      const seen = new Set<string>();

      for (const query of queries) {
        if (allJobs.length >= 500) break; // cap per run
        try {
          const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=50&what=${encodeURIComponent(query)}&content-type=application/json&sort_by=relevance`;
          const response = await this.fetchWithRetry(url);

          if (response.ok) {
            const data: AdzunaApiResponse = await response.json();
            const transformedJobs = this.transformAdzunaJobs(data.results || []);

            for (const job of transformedJobs) {
              const key = `${job.title}::${job.company}`.toLowerCase();
              if (!seen.has(key)) {
                seen.add(key);
                allJobs.push(job);
              }
            }
          }

          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
          console.log(`[Adzuna] Skipping query "${query}":`, (error as Error).message);
        }
      }

      console.log(`[Adzuna] Fetched ${allJobs.length} jobs across ${queries.length} queries`);
      return allJobs;
    } catch (error) {
      console.error('[Adzuna] Error:', error);
      return [];
    }
  }

  private transformMuseJobs(jobs: any[]): ExternalJob[] {
    // Drop entries without a per-job landing page rather than falling back to
    // themuse.com (per ingestion URL contract).
    return jobs
      .filter(job => typeof job.refs?.landing_page === 'string' && job.refs.landing_page.length > 0)
      .map((job, index) => ({
        id: `muse_${job.id || Date.now()}_${index}`,
        title: job.name || 'Software Position',
        company: job.company?.name || 'Company',
        location: job.locations?.[0]?.name || 'Remote',
        description: job.contents || job.name || '',
        requirements: this.extractRequirements(job.contents || ''),
        skills: this.extractSkills(job.name + ' ' + (job.contents || '')),
        workType: job.locations?.[0]?.name?.toLowerCase().includes('remote') ? 'remote' : 'onsite',
        salaryMin: undefined,
        salaryMax: undefined,
        source: 'The Muse',
        externalUrl: job.refs.landing_page,
        postedDate: job.publication_date || new Date().toISOString(),
        trustScore: getSourceTrustScore('The Muse')
      }));
  }


  // URL validation method to ensure only real, working URLs are included
  private isValidURL(urlString: string): boolean {
    try {
      const url = new URL(urlString);

      // Check for valid protocols
      if (!['http:', 'https:'].includes(url.protocol)) {
        return false;
      }

      // Block common placeholder URLs
      const invalidPatterns = [
        '#',
        'javascript:',
        'mailto:',
        'example.com',
        'localhost',
        '127.0.0.1',
        'recrutas.ai', // Our own domain placeholders
        'undefined',
        'null'
      ];

      const lowerUrl = urlString.toLowerCase();
      if (invalidPatterns.some(pattern => lowerUrl.includes(pattern))) {
        return false;
      }

      // Ensure hostname exists and is not empty
      if (!url.hostname || url.hostname.length < 3) {
        return false;
      }

      // Must have a valid TLD
      if (!url.hostname.includes('.')) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }
}

export const jobAggregator = new JobAggregator();