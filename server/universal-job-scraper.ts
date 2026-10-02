import Groq from "groq-sdk";
import { groqModel, groqReasoningParams } from "./lib/ai-client";

interface UniversalJob {
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
  postedDate: string;
}

export class UniversalJobScraper {
  private readonly USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  private _groq: Groq | null = null;
  private _groqInitialized = false;

  // Lazy-initialize Groq to ensure env vars are loaded (ESM imports hoist before dotenv.config)
  private get groq(): Groq {
    if (!this._groqInitialized) {
      this._groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      this._groqInitialized = true;
    }
    return this._groq!;
  }
  
  async scrapeCompanyJobs(companyUrl: string, companyName?: string): Promise<UniversalJob[]> {
    try {
      console.log(`[scraper] Scraping jobs from: ${companyUrl}`);
      
      const response = await fetch(companyUrl, {
        headers: {
          'User-Agent': this.USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        }
      });

      console.log(`[scraper] Fetched ${companyUrl} with status: ${response.status}`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      console.log(`[scraper] Fetched ${html.length} characters from ${companyUrl}`);

      const jobs = this.parseJobsFromHTML(html, companyUrl, companyName);
      console.log(`[scraper] Extracted ${jobs.length} jobs from ${companyUrl}`);
      
      console.log('[scraper] Enhancing jobs with AI...');
      const enhancedJobs = await Promise.all(jobs.map(async (job) => {
        const enhancedDetails = await this.getEnhancedJobDetails(job.description);
        return { ...job, ...enhancedDetails };
      }));
      console.log('[scraper] Finished enhancing jobs.');

      return enhancedJobs;
    } catch (error) {
      console.error(`[scraper] Failed to scrape ${companyUrl}:`, (error as Error).message);
      return []; // Only return authentic scraped data
    }
  }

  private parseJobsFromHTML(html: string, sourceUrl: string, companyName?: string): UniversalJob[] {
    const jobs: UniversalJob[] = [];
    const domain = new URL(sourceUrl).hostname;
    
    // Method 1: JSON-LD Structured Data
    const jsonLdJobs = this.extractJsonLdJobs(html, sourceUrl, companyName);
    jobs.push(...jsonLdJobs);

    // Method 2: Next.js/React Data Islands
    const dataIslandJobs = this.extractDataIslandJobs(html, sourceUrl, companyName);
    jobs.push(...dataIslandJobs);

    // Method 3: HTML Structure Parsing (simplified)
    const htmlJobs = this.extractSimpleHtmlJobs(html, sourceUrl, companyName);
    jobs.push(...htmlJobs);

    // Remove duplicates and return
    return this.deduplicateJobs(jobs).slice(0, 50);
  }

  private extractJsonLdJobs(html: string, sourceUrl: string, companyName?: string): UniversalJob[] {
    const jobs: UniversalJob[] = [];
    const jsonLdPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/g;
    const matches = Array.from(html.matchAll(jsonLdPattern));

    for (const match of matches) {
      try {
        const jsonData = JSON.parse(match[1]);
        const jobPostings = this.extractJobPostingsFromJsonLd(jsonData);
        
        for (const posting of jobPostings) {
          if (posting.title && posting.hiringOrganization) {
            jobs.push({
              id: `jsonld_${this.generateId(posting.title, posting.hiringOrganization?.name)}`,
              title: posting.title || 'Software Engineer',
              company: companyName || posting.hiringOrganization?.name || new URL(sourceUrl).hostname,
              location: this.parseLocation(posting.jobLocation),
              description: posting.description || '',
              requirements: this.extractRequirements(posting.description || ''),
              skills: this.extractSkills(posting.title + ' ' + (posting.description || '')),
              workType: this.parseWorkType(posting.employmentType),
              salaryMin: posting.baseSalary?.value?.minValue,
              salaryMax: posting.baseSalary?.value?.maxValue,
              source: companyName || new URL(sourceUrl).hostname,
              externalUrl: posting.url || sourceUrl,
              postedDate: posting.datePosted || new Date().toISOString(),
            });
          }
        }
      } catch (error) {
        console.log('Failed to parse JSON-LD:', error);
      }
    }

    return jobs;
  }

  private extractJobPostingsFromJsonLd(data: any): any[] {
    const jobs: any[] = [];
    
    if (data && data['@type'] === 'JobPosting') {
      jobs.push(data);
    } else if (Array.isArray(data)) {
      for (const item of data) {
        jobs.push(...this.extractJobPostingsFromJsonLd(item));
      }
    } else if (typeof data === 'object' && data !== null) {
      for (const key in data) {
        if (data[key] && typeof data[key] === 'object') {
          jobs.push(...this.extractJobPostingsFromJsonLd(data[key]));
        }
      }
    }

    return jobs;
  }

  private extractDataIslandJobs(html: string, sourceUrl: string, companyName?: string): UniversalJob[] {
    const jobs: UniversalJob[] = [];
    
    // Common patterns for job data in JavaScript
    const patterns = [
      /"jobs":\s*(\[.*?\])/,
      /"positions":\s*(\[.*?\])/,
      /"listings":\s*(\[.*?\])/,
      /"careers":\s*(\[.*?\])/,
      /"openings":\s*(\[.*?\])/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        try {
          const data = JSON.parse(match[1]);
          const extractedJobs = this.parseJobDataFromArray(data, sourceUrl, companyName);
          jobs.push(...extractedJobs);
        } catch (error) {
          console.log('Failed to parse data island:', error);
        }
      }
    }

    return jobs;
  }

  private parseJobDataFromArray(data: any[], sourceUrl: string, companyName?: string): UniversalJob[] {
    const jobs: UniversalJob[] = [];
    
    if (Array.isArray(data)) {
      for (const item of data) {
        if (this.isJobObject(item)) {
          jobs.push(this.transformToUniversalJob(item, sourceUrl, companyName));
        }
      }
    }

    return jobs;
  }

  private extractSimpleHtmlJobs(html: string, sourceUrl: string, companyName?: string): UniversalJob[] {
    const jobs: UniversalJob[] = [];
    
    // Enhanced job title patterns
    const titlePatterns = [
      /(?:Senior|Junior|Lead|Staff|Principal)?\s*(?:Software Engineer|Software Developer|Developer|Frontend Engineer|Backend Engineer|Full Stack Engineer|Full Stack Developer|Data Scientist|Data Engineer|Product Manager|UX Designer|UI Designer|DevOps Engineer|Site Reliability Engineer|Mobile Developer|iOS Developer|Android Developer|QA Engineer|Security Engineer|Machine Learning Engineer|AI Engineer)/gi
    ];

    // Also look for job listing patterns in HTML structure
    const jobListingPatterns = [
      /<div[^>]*(?:class|id)="[^"]*(?:job|position|career|opening)[^"]*"[^>]*>(.*?)<\/div>/gi,
      /<li[^>]*(?:class|id)="[^"]*(?:job|position|career|opening)[^"]*"[^>]*>(.*?)<\/li>/gi,
      /<article[^>]*>(.*?)<\/article>/gi,
    ];

    const titles = new Set<string>();
    
    // Extract from title patterns
    for (const pattern of titlePatterns) {
      const matches = Array.from(html.matchAll(pattern));
      for (const match of matches) {
        titles.add(match[0].trim());
      }
    }

    // Extract from job listing HTML structures
    for (const pattern of jobListingPatterns) {
      const matches = Array.from(html.matchAll(pattern));
      for (const match of matches) {
        const content = match[1];
        const titleMatch = content.match(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>|<[^>]*(?:class|id)="[^"]*title[^"]*"[^>]*>([^<]+)</i);
        if (titleMatch) {
          const title = (titleMatch[1] || titleMatch[2] || '').trim();
          if (title && title.length > 3 && title.length < 100) {
            titles.add(title);
          }
        }
      }
    }

    let index = 0;
    const titleArray = Array.from(titles);
    
    for (const title of titleArray) {
      if (index >= 15) {break;} // Increased limit for better coverage
      
      // Skip generic or invalid titles
      if (title.length < 5 || title.includes('Apply') || title.includes('Login') || title.includes('Search')) {
        continue;
      }
      
      // Only include jobs with specific application URLs
      const specificJobUrl = this.findSpecificJobUrl(html, title, sourceUrl);
      if (specificJobUrl) {
        jobs.push({
          id: `html_${this.generateId(title, companyName)}_${index}`,
          title: title,
          company: companyName || new URL(sourceUrl).hostname.replace('www.', '').replace('.com', ''),
          location: this.inferLocationFromHtml(html) || 'Remote',
          description: `${title} position at ${companyName || new URL(sourceUrl).hostname}. Join our team and make an impact.`,
          requirements: this.extractRequirements(title),
          skills: this.extractSkills(title),
          workType: this.inferWorkTypeFromHtml(html, title),
          source: companyName || new URL(sourceUrl).hostname,
          externalUrl: specificJobUrl,
          postedDate: new Date().toISOString(),
        });
        index++;
      }
    }

    return jobs;
  }

  private findSpecificJobUrl(html: string, jobTitle: string, sourceUrl: string): string | null {
    const domain = new URL(sourceUrl).hostname;
    
    // Enhanced patterns for specific job URLs based on common company patterns
    const jobUrlPatterns = [
      // Shopify pattern: /careers/job-title_uuid
      /href="([^"]*\/careers\/[^"]*[a-f0-9-]{36}[^"]*)"/gi,
      // General UUID patterns: job IDs with UUIDs
      /href="([^"]*\/(?:job|career|position|apply)\/[^"]*[a-f0-9-]{8,}[^"]*)"/gi,
      // Numeric job IDs
      /href="([^"]*\/(?:job|career|position|apply)\/[^"]*\d{4,}[^"]*)"/gi,
      // Job slug patterns with hyphens
      /href="([^"]*\/(?:job|career|position|apply)\/[a-z0-9-]{10,}[^"]*)"/gi,
    ];
    
    // Try each pattern to find specific job URLs
    for (const pattern of jobUrlPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const url = match[1];
        
        // Convert relative URLs to absolute
        let absoluteUrl = url;
        if (url.startsWith('/')) {
          absoluteUrl = new URL(url, sourceUrl).href;
        } else if (!url.startsWith('http')) {
          continue; // Skip invalid URLs
        }
        
        // Verify it's a job-specific URL (not just career page)
        if (absoluteUrl !== sourceUrl && 
            absoluteUrl.length > sourceUrl.length + 10 && // Must be significantly longer
            (absoluteUrl.includes('job') || absoluteUrl.includes('career') || absoluteUrl.includes('position'))) {
          return absoluteUrl;
        }
      }
    }
    
    // Fallback: look for any link containing job title words
    const titleWords = jobTitle.toLowerCase().split(/\s+/).filter(word => word.length > 3);
    const linkRegex = /<a[^>]*href="([^"]*)"[^>]*>([^<]*)</gi;
    let match;
    
    while ((match = linkRegex.exec(html)) !== null) {
      const url = match[1];
      const linkText = match[2].toLowerCase();
      
      // Check if link text contains job title and URL looks job-specific
      if (titleWords.some(word => linkText.includes(word))) {
        let absoluteUrl = url;
        if (url.startsWith('/')) {
          absoluteUrl = new URL(url, sourceUrl).href;
        } else if (!url.startsWith('http')) {
          continue;
        }
        
        // Must be significantly longer than base URL and contain job indicators
        if (absoluteUrl !== sourceUrl && 
            absoluteUrl.length > sourceUrl.length + 15 &&
            (absoluteUrl.includes('job') || absoluteUrl.includes('career') || absoluteUrl.includes('position'))) {
          return absoluteUrl;
        }
      }
    }
    
    // If no specific job URL found, return null
    return null;
  }

  private inferLocationFromHtml(html: string): string | null {
    const locationPatterns = [
      /(?:San Francisco|New York|Seattle|Austin|Boston|Denver|Chicago|Los Angeles|Remote|Hybrid)/gi
    ];
    
    for (const pattern of locationPatterns) {
      const match = html.match(pattern);
      if (match) {
        return match[0];
      }
    }
    
    return null;
  }

  private inferWorkTypeFromHtml(html: string, title: string): string {
    const combined = (html + ' ' + title).toLowerCase();
    
    if (combined.includes('remote')) {return 'remote';}
    if (combined.includes('onsite') || combined.includes('office')) {return 'onsite';}
    return 'hybrid';
  }

  private isJobObject(obj: any): boolean {
    if (typeof obj !== 'object' || obj === null) {return false;}
    
    const jobFields = ['title', 'position', 'role', 'job_title', 'name'];
    const hasJobField = jobFields.some(field => obj[field]);
    
    return hasJobField;
  }

  private transformToUniversalJob(obj: any, sourceUrl: string, companyName?: string): UniversalJob {
    return {
      id: `api_${this.generateId(obj.title || obj.position || obj.role, companyName)}`,
      title: obj.title || obj.position || obj.role || obj.job_title || obj.name,
      company: companyName || obj.company || obj.employer || obj.organization || obj.company_name || new URL(sourceUrl).hostname,
      location: obj.location || obj.city || obj.office_location || 'Remote',
      description: obj.description || obj.summary || obj.job_description || '',
      requirements: this.extractRequirements(obj.requirements || obj.description || ''),
      skills: this.extractSkills(obj.skills || obj.technologies || obj.title || ''),
      workType: this.parseWorkType(obj.employment_type || obj.work_type || obj.type),
      salaryMin: obj.salary_min || obj.min_salary || obj.salary?.min,
      salaryMax: obj.salary_max || obj.max_salary || obj.salary?.max,
      source: companyName || new URL(sourceUrl).hostname,
      externalUrl: obj.url || obj.link || obj.apply_url || sourceUrl,
      postedDate: obj.posted_date || obj.created_at || obj.date_posted || new Date().toISOString(),
    };
  }

  private extractRequirements(text: string): string[] {
    const requirements: string[] = [];
    const lines = text.split('\n');
    
    for (const line of lines) {
      const cleaned = line.trim();
      if (cleaned.length > 10 && (
        cleaned.includes('experience') ||
        cleaned.includes('required') ||
        cleaned.includes('must have') ||
        cleaned.includes('qualification')
      )) {
        requirements.push(cleaned);
      }
    }
    
    return requirements.slice(0, 5);
  }

  private extractSkills(text: string): string[] {
    const skillKeywords = [
      'JavaScript', 'TypeScript', 'React', 'Vue', 'Angular', 'Node.js', 'Python', 'Java', 'Go', 'Rust',
      'Docker', 'Kubernetes', 'AWS', 'GCP', 'Azure', 'PostgreSQL', 'MongoDB', 'Redis',
      'Git', 'CI/CD', 'GraphQL', 'REST', 'API', 'Microservices', 'DevOps', 'Machine Learning',
      'Data Science', 'AI', 'Frontend', 'Backend', 'Full Stack', 'Mobile', 'iOS', 'Android'
    ];
    
    const skills: string[] = [];
    const lowerText = text.toLowerCase();
    
    for (const skill of skillKeywords) {
      if (lowerText.includes(skill.toLowerCase())) {
        skills.push(skill);
      }
    }
    
    return Array.from(new Set(skills));
  }

  private parseLocation(location: any): string {
    if (typeof location === 'string') {return location;}
    if (location?.address?.addressLocality) {return location.address.addressLocality;}
    if (location?.name) {return location.name;}
    return 'Remote';
  }

  private parseWorkType(employmentType: any): string {
    if (!employmentType) {return 'hybrid';}
    const type = employmentType.toString().toLowerCase();
    
    if (type.includes('remote')) {return 'remote';}
    if (type.includes('onsite') || type.includes('office')) {return 'onsite';}
    return 'hybrid';
  }

  private generateId(title: string, company?: string): string {
    const str = `${title}_${company}_${Date.now()}`;
    return str.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  }

  private deduplicateJobs(jobs: UniversalJob[]): UniversalJob[] {
    const seen = new Set<string>();
    return jobs.filter(job => {
      const key = `${job.title}_${job.company}`.toLowerCase();
      if (seen.has(key)) {return false;}
      seen.add(key);
      return true;
    });
  }

  // Method to scrape multiple companies
  async scrapeMultipleCompanies(companyUrls: { url: string; name: string }[]): Promise<UniversalJob[]> {
    const allJobs: UniversalJob[] = [];
    
    for (const { url, name } of companyUrls) {
      try {
        const jobs = await this.scrapeCompanyJobs(url, name);
        allJobs.push(...jobs);
      } catch (error) {
        console.error(`Failed to scrape ${name}:`, error);
      }
    }
    
    return this.deduplicateJobs(allJobs);
  }

  async getEnhancedJobDetails(description: string): Promise<{ summary: string; skills: string[] }> {
    try {
      const summaryResponse = await this.runGroq('Summarize this job description: ' + description);
      const skillsResponse = await this.runGroq('Extract the skills from this job description: ' + description);

      const skills = skillsResponse.split(',').map(skill => skill.trim());

      return { summary: summaryResponse, skills };
    } catch (error) {
      console.error('Failed to get enhanced job details from Groq:', error);
      return { summary: '', skills: [] };
    }
  }

  private async runGroq(prompt: string): Promise<string> {
    const model = groqModel();
    const chatCompletion = await this.groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model,
      ...groqReasoningParams(model),
    });
    return chatCompletion.choices[0]?.message?.content || '';
  }
}

export const universalJobScraper = new UniversalJobScraper();