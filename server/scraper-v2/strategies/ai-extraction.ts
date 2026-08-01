/**
 * AI-Powered Job Extraction
 *
 * Uses LLM (Groq API or Ollama) to intelligently extract job listings from HTML.
 * This is the fallback method when structured data and APIs are not available.
 * It's significantly better than regex-based parsing.
 */

import crypto from 'crypto';
import Groq from 'groq-sdk';
import { ScrapedJob, CompanyConfig, JobLocation } from '../types.js';
import { logger } from '../utils/logger.js';
import { callAI } from '../../lib/ai-client.js';

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB

// Groq's free tier caps a SINGLE request at 12,000 tokens (TPM) and rejects
// anything over it with a hard 413 instead of truncating — so an oversized
// payload returns zero jobs, not fewer jobs.
//
// Cleaned career-page HTML tokenizes at roughly 2.1 chars/token, far denser than
// prose. Measured 2026-08-01: the previous 25,000-char cap billed 12,042 tokens
// against the 12,000 limit — a 42-token overshoot that had been failing Google's
// board on every run. The cap was picked in characters without accounting for
// HTML token density or the ~350-token system prompt.
//
// 20,000 chars ≈ 9,500 tokens, leaving headroom for the system prompt and for
// tokenizer variance across sites. Large boards are truncation-bound either way
// (Microsoft's cleaned page is ~678,000 chars); the only question is whether we
// get a partial extraction or nothing at all.
const MAX_HTML_CHARS = 20_000;

// Conservative — under-estimating chars/token over-estimates the token count,
// which is the safe direction for both the 413 ceiling and throttler pacing.
const CHARS_PER_TOKEN = 2.1;
const SYSTEM_PROMPT_TOKENS = 400;

function truncateForAI(html: string): string {
  return html.length > MAX_HTML_CHARS
    ? html.substring(0, MAX_HTML_CHARS) + '\n...[truncated]'
    : html;
}

function estimateTokens(prompt: string): number {
  return Math.ceil(prompt.length / CHARS_PER_TOKEN) + SYSTEM_PROMPT_TOKENS;
}

interface AIExtractedJob {
  title: string;
  location: string;
  description: string;
  requirements: string[];
  responsibilities: string[];
  skills: string[];
  workType: 'remote' | 'onsite' | 'hybrid';
  employmentType: 'full-time' | 'part-time' | 'contract' | 'internship';
  experienceLevel: 'entry' | 'mid' | 'senior' | 'staff';
  salary?: {
    min?: number;
    max?: number;
    currency: string;
    period: string;
  };
  externalUrl?: string;
  department?: string;
  team?: string;
}

interface AIResponse {
  jobs: AIExtractedJob[];
  confidence: number;
  totalFound: number;
}

// Lazy-initialize Groq client
let groqClient: Groq | null = null;

function getGroqClient(): Groq {
  if (!groqClient) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY environment variable not set');
    }
    groqClient = new Groq({ apiKey });
  }
  return groqClient;
}

/**
 * Check if Ollama is available
 */
async function isOllamaAvailable(): Promise<boolean> {
  try {
    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const response = await fetch(`${ollamaUrl}/api/tags`, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Extract jobs using AI
 */
export async function extractWithAI(
  company: CompanyConfig,
  fetchOptions: RequestInit
): Promise<ScrapedJob[]> {
  try {
    // Fetch the career page HTML
    const response = await fetch(company.careerPageUrl, fetchOptions);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check Content-Length before reading body
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      throw new Error(`Response too large: ${contentLength} bytes`);
    }

    const html = await response.text();
    if (html.length > MAX_RESPONSE_SIZE) {
      throw new Error(`Response body too large: ${html.length} chars`);
    }

    // Clean HTML for AI processing
    const cleanedHtml = cleanHtmlForAI(html);
    
    logger.info(`Extracting jobs with AI for ${company.name}`, {
      company: company.name,
      htmlLength: cleanedHtml.length
    });

    // Use AI to extract jobs
    const aiResponse = await callAIForExtraction(cleanedHtml, company);
    
    // Convert AI response to ScrapedJob objects
    const jobs = convertToScrapedJobs(aiResponse.jobs, company);
    
    logger.info(`AI extracted ${jobs.length} jobs for ${company.name}`, {
      confidence: aiResponse.confidence,
      totalFound: aiResponse.totalFound
    });

    return jobs;

  } catch (error) {
    logger.error(`AI extraction failed for ${company.name}`, {
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

const systemPrompt = `You are a precise job listing extractor. Extract all job postings from the provided HTML.

Rules:
1. Only extract actual job postings, not navigation links or other content
2. Extract complete information for each job
3. If a field is not found, omit it or use null
4. Be precise with job titles - don't make them up
5. Extract specific URLs if available, otherwise use null
6. Maximum 20 jobs

Return JSON in this exact format:
{
  "jobs": [
    {
      "title": "Job Title",
      "location": "City, State/Country or Remote",
      "description": "Brief 2-3 sentence description",
      "requirements": ["requirement 1", "requirement 2"],
      "responsibilities": ["responsibility 1", "responsibility 2"],
      "skills": ["skill1", "skill2"],
      "workType": "remote|onsite|hybrid",
      "employmentType": "full-time|part-time|contract|internship",
      "experienceLevel": "entry|mid|senior|staff",
      "salary": {
        "min": 100000,
        "max": 150000,
        "currency": "USD",
        "period": "yearly"
      },
      "externalUrl": "https://...",
      "department": "Engineering",
      "team": "Platform Team"
    }
  ],
  "confidence": 0.85,
  "totalFound": 5
}`;

/**
 * Call Ollama AI for job extraction (open source, unlimited)
 */
async function callOllamaForExtraction(html: string, company: CompanyConfig): Promise<AIResponse> {
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.2';

  // Truncate HTML to fit in context window
  const maxLength = 15000;
  const truncatedHtml = html.length > maxLength
    ? html.substring(0, maxLength) + '\n...[truncated]'
    : html;

  logger.info(`Using Ollama with model ${ollamaModel} for ${company.name}`);

  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      prompt: `${systemPrompt}\n\nExtract job listings from ${company.name}'s careers page:\n\n${truncatedHtml}\n\nRespond with valid JSON only.`,
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: 4000
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
  }

  const result = await response.json() as { response?: string };
  const content = result.response;

  if (!content) {
    throw new Error('Empty response from Ollama');
  }

  // Extract JSON from response (Ollama might add markdown or extra text)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in Ollama response');
  }

  const parsed = JSON.parse(jsonMatch[0]) as AIResponse;

  if (!parsed.jobs || !Array.isArray(parsed.jobs)) {
    throw new Error('Invalid AI response structure from Ollama');
  }

  return parsed;
}

/**
 * Call Groq AI for job extraction
 */
async function callGroqForExtraction(html: string, company: CompanyConfig): Promise<AIResponse> {
  const groq = getGroqClient();

  // Same 12,000-token per-request ceiling as the unified client path above.
  const truncatedHtml = truncateForAI(html);

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Extract job listings from ${company.name}'s careers page:\n\n${truncatedHtml}`
      }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 4000
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from AI');
  }

  const parsed = JSON.parse(content) as AIResponse;

  if (!parsed.jobs || !Array.isArray(parsed.jobs)) {
    throw new Error('Invalid AI response structure');
  }

  return parsed;
}

/**
 * Call AI for job extraction (tries Ollama first if available, then Groq)
 */
async function callAIForExtraction(html: string, company: CompanyConfig): Promise<AIResponse> {
  const truncatedHtml = truncateForAI(html);
  const userPrompt = `Extract job listings from ${company.name}'s careers page:\n\n${truncatedHtml}`;

  // Use unified AI client (Gemini-first, Groq fallback) to avoid burning Groq tokens.
  // estimatedTokens paces the Groq throttler, so it has to track the real payload:
  // the previous hardcoded 5000 under-reserved by ~2.4x against a measured 12,042,
  // letting through far more requests per minute than the budget could fund.
  const content = await callAI(
    systemPrompt,
    userPrompt,
    { priority: 'low', estimatedTokens: estimateTokens(userPrompt), temperature: 0.1, maxOutputTokens: 4000 }
  );

  if (!content) {
    throw new Error('Empty response from AI');
  }

  const parsed = JSON.parse(content) as AIResponse;

  if (!parsed.jobs || !Array.isArray(parsed.jobs)) {
    throw new Error('Invalid AI response structure');
  }

  return parsed;
}

/**
 * Convert AI-extracted jobs to ScrapedJob format
 */
function convertToScrapedJobs(aiJobs: AIExtractedJob[], company: CompanyConfig): ScrapedJob[] {
  return aiJobs.map((job, index) => {
    const location: JobLocation = {
      raw: job.location || 'Remote',
      isRemote: job.workType === 'remote' || job.location?.toLowerCase().includes('remote'),
      country: '',
      countryCode: '',
      normalized: (job.location || 'remote').toLowerCase()
    };

    return {
      id: crypto.createHash('sha256').update(`${company.id}:${job.title}:${job.location || ''}`).digest('hex').slice(0, 16),
      title: job.title,
      normalizedTitle: '',
      company: company.name,
      companyId: company.id,
      location,
      description: job.description,
      descriptionHtml: undefined,
      requirements: job.requirements?.map(r => ({
        type: 'other',
        description: r,
        isRequired: true
      })) || [],
      responsibilities: job.responsibilities || [],
      skills: job.skills || [],
      skillCategories: [],
      workType: job.workType || 'hybrid',
      employmentType: job.employmentType || 'full-time',
      experienceLevel: job.experienceLevel || 'mid',
      salary: job.salary ? {
        min: job.salary.min,
        max: job.salary.max,
        currency: job.salary.currency || 'USD',
        period: (job.salary.period as any) || 'yearly',
        isDisclosed: !!(job.salary.min || job.salary.max)
      } : {
        currency: 'USD',
        period: 'yearly',
        isDisclosed: false
      },
      benefits: [],
      externalUrl: job.externalUrl || company.careerPageUrl,
      source: {
        type: 'career_page',
        company: company.name,
        url: company.careerPageUrl,
        scrapeMethod: 'ai_extraction'
      },
      postedDate: new Date(),
      scrapedAt: new Date(),
      updatedAt: new Date(),
      status: 'active',
      isRemote: location.isRemote,
      department: job.department,
      team: job.team
    };
  });
}

/**
 * Clean HTML for AI processing
 */
function cleanHtmlForAI(html: string): string {
  return html
    // Remove script and style tags
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Remove comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Remove common non-content elements
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    // Keep only relevant elements
    .replace(/<(div|section|article|main|ul|li|a|h[1-6]|p)[^>]*>/gi, '<$1>')
    // Remove all other attributes
    .replace(/<([a-z0-9]+)[^>]*>/gi, '<$1>')
    // Normalize whitespace
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();
}
