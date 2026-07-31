import type { Express } from "express";
import { eq } from "drizzle-orm";
import { inArray } from "drizzle-orm/sql/expressions";
import { sql } from "drizzle-orm/sql";
import multer from "multer";
import path from "path";
import fs from "fs";
import { z } from "zod";

import { storage } from "./storage";
import { isAuthenticated } from "./middleware/auth";
import { companyJobsAggregator } from "./company-jobs-aggregator";
import { universalJobScraper } from "./universal-job-scraper";
import { jobAggregator } from "./job-aggregator";
import { notificationService } from "./notification-service";
import { newsService } from './news-service';
import {
  insertCandidateProfileSchema,
  insertJobPostingSchema,
  updateJobPostingSchema,
  scheduleInterviewSchema,
  completeTalentOwnerProfileSchema,
  users,
  jobPostings,
  jobApplications,
  candidateProfiles,
  JobPosting,
  waitlistEntries,
} from "@shared/schema";
import { generateScreeningQuestions } from "./ai-service";
import { callAI, callAIWithImage, isAIAvailable } from "./lib/ai-client";
import { db, testDbConnection } from "./db";
import { seedDatabase } from "./seed.js";
import { ResumeService, ResumeProcessingError } from './services/resume.service';
import { ExamService } from './services/exam.service';
import { aiResumeParser } from './ai-resume-parser';
import { applicationIntelligence } from "./application-intelligence";
import { supabaseAdmin } from "./lib/supabase-admin";
import { CompanyJob } from '../server/company-jobs-aggregator';
import { externalJobsScheduler } from './services/external-jobs-scheduler';
import { jobIngestionService } from './services/job-ingestion.service';
import { getModelInfo } from './ml-matching';
import { sendWelcomeEmail, sendEmail } from './email-service';
import { sendEmail as sendTransactionalEmail, employerWelcomeEmail, employerNewApplicantEmail } from './lib/email';
import { track as serverTrack } from './lib/analytics';
// greenhouse-submit.service.ts kept for future use (verification code flow, etc.)
import { asyncHandler } from './middleware/error-handler';
import { verifyAdminSecret, verifyCronSecret } from './middleware/security';
import rateLimit from 'express-rate-limit';
import { captureException } from './error-monitoring';
import { recordMatchSignal, joinExamScore, type SignalAction } from './services/match-signals.service';
import { scoreJob } from './job-scorer';

/**
 * Fire-and-forget: record a match signal with the full feature snapshot.
 * Never blocks the request path — errors are swallowed.
 */
function recordSignal(candidateId: string, jobId: number, action: SignalAction, job?: any): void {
  const resolve = job ? Promise.resolve(job) : storage.getJobPosting(jobId);
  resolve.then(j => {
    if (!j) return;
    storage.getCandidateUser(candidateId).then(cp => {
      if (!cp) return;
      const skills = Array.isArray(cp.skills) ? (cp.skills as string[]) : [];
      const score = scoreJob(skills, cp.experienceLevel, j);
      recordMatchSignal(candidateId, jobId, action, score).catch(() => {});
    }).catch(() => {});
  }).catch(() => {});
}

// Admin/owner accounts bypass daily usage limits
// Set via ADMIN_EMAILS env var (comma-separated): "alice@example.com,bob@example.com"
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '').replace(/\\n/g, '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);
function isAdminUser(req: any): boolean {
  return ADMIN_EMAILS.has(req.user?.email?.toLowerCase());
}

type AggregatedJob = (JobPosting | CompanyJob) & { aiCurated: boolean };

interface AIMatch {
  id: number;
  job: (JobPosting | CompanyJob) & { confidenceScore: number };
  matchScore: string;
  confidenceLevel: number;
  aiExplanation: string;
  status: string;
  createdAt: string;
}


// Instantiate services
const resumeService = new ResumeService(storage, aiResumeParser);
const examService = new ExamService(storage, notificationService);

// Helper function to safely parse integer params
function parseIntParam(value: string | undefined): number | null {
  if (!value) {return null;}
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? null : parsed;
}

// Background job processor for async job posting
// Processes candidate matching and notifications in the background
// Uses setTimeout with 0ms delay for better Vercel serverless compatibility
function processJobMatchesInBackground(jobId: number) {
  // Fire and forget - process in background without blocking the request
  // Use setTimeout instead of setImmediate for better Vercel compatibility
  setTimeout(async () => {
    try {
      console.log(`[Background] Starting candidate matching for job ${jobId}`);
      const job = await storage.getJobPosting(jobId);
      if (!job) {
        console.error(`[Background] Job ${jobId} not found`);
        return;
      }

      // Fetch matching candidates
      const candidates = await storage.findMatchingCandidates(jobId);
      console.log(`[Background] Found ${candidates.length} matching candidates for job ${jobId}`);

      // Process matches in batches to avoid overwhelming the system
      const BATCH_SIZE = 5;
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);

        try {
          // Process batch in parallel
          await Promise.all(
            batch.map(async (candidate) => {
              // Create job match
              await storage.createJobMatch({
                jobId: job.id,
                ...candidate,
              });

              // Send notification
              await notificationService.createNotification({
                userId: candidate.candidateId,
                type: "new_match",
                title: "New Job Match",
                message: `You have a new match for the position of ${job.title}`,
                data: { jobId: job.id },
              }).catch(err => console.error(`[Background] Notification failed for candidate ${candidate.candidateId}:`, err?.message));
            })
          );

          console.log(`[Background] Processed batch ${Math.floor(i / BATCH_SIZE) + 1} for job ${jobId}`);
        } catch (batchError) {
          console.error(`[Background] Batch processing error for job ${jobId}:`, (batchError as Error)?.message);
          // Continue with next batch
        }
      }

      console.log(`[Background] Completed candidate matching for job ${jobId}`);
    } catch (error) {
      console.error(`[Background] Error processing job matches for job ${jobId}:`, (error as Error)?.message);
    }
  }, 0);
}

// Magic bytes for file type validation
const FILE_SIGNATURES = {
  // PDF starts with %PDF
  pdf: [0x25, 0x50, 0x44, 0x46],
  // DOC starts with D0 CF 11 E0 (Microsoft Compound Document)
  doc: [0xD0, 0xCF, 0x11, 0xE0],
  // DOCX is a ZIP file starting with PK
  docx: [0x50, 0x4B, 0x03, 0x04],
};

function validateFileSignature(buffer: Buffer, extension: string): boolean {
  if (buffer.length < 4) {return false;}

  const ext = extension.toLowerCase().replace('.', '');
  const signature = FILE_SIGNATURES[ext as keyof typeof FILE_SIGNATURES];

  if (!signature) {return false;}

  // Check if the file starts with the expected magic bytes
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) {
      return false;
    }
  }
  return true;
}

// Configure multer for file uploads
// Use memory storage for serverless compatibility (no filesystem access)
const storageConfig = multer.memoryStorage();
const upload = multer({
  storage: storageConfig,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.pdf', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and Word documents are allowed'));
    }
  }
});

async function generateExamQuestions(job: any) {
  const skills = job.skills || [];
  const requirements = job.requirements || [];

  // Try AI-powered generation first
  if (isAIAvailable()) {
    try {
      const systemPrompt = `You are an expert technical recruiter creating a screening exam for job candidates.
Generate exactly 5 questions that test real competence for the role — not self-assessments.

Rules:
- 3 multiple-choice questions (4 options each, one correct answer)
- 2 short-answer questions (practical scenarios)
- Questions must be specific to the job, not generic
- Multiple-choice questions should test knowledge, not experience level
- Short-answer questions should present a realistic work scenario
- Each question is worth 20 points (100 total)
- correctAnswer for multiple-choice is the 0-based index of the correct option

Return JSON: { "questions": [ { "id": "q1"..."q5", "question": string, "type": "multiple-choice"|"short-answer", "options": string[] (only for multiple-choice), "correctAnswer": number (only for multiple-choice), "points": 20 } ] }`;

      const userPrompt = `Job Title: ${job.title}
Company: ${job.company || 'Unknown'}
Description: ${(job.description || '').slice(0, 2000)}
Skills: ${skills.join(', ') || 'Not specified'}
Requirements: ${(requirements || []).join('; ') || 'Not specified'}`;

      const raw = await callAI(systemPrompt, userPrompt, {
        priority: 'high',
        estimatedTokens: 1500,
        temperature: 0.3,
        maxOutputTokens: 2000,
      });

      const parsed = JSON.parse(raw);
      const questions = parsed.questions || parsed;

      if (Array.isArray(questions) && questions.length >= 3) {
        // Normalize: ensure IDs, points, and types are valid
        return questions.slice(0, 5).map((q: any, i: number) => ({
          id: q.id || `q${i + 1}`,
          question: q.question,
          type: q.type === 'multiple-choice' ? 'multiple-choice' : 'short-answer',
          ...(q.type === 'multiple-choice' ? { options: q.options, correctAnswer: q.correctAnswer } : {}),
          points: 20,
        }));
      }
    } catch (err) {
      console.warn('[ExamGen] AI generation failed, using fallback:', (err as Error).message);
    }
  }

  // Fallback: template-based generation
  const questions = [];
  for (let i = 0; i < Math.min(skills.length, 3); i++) {
    questions.push({
      id: `skill_${i + 1}`,
      question: `What is your experience level with ${skills[i]}?`,
      type: 'multiple-choice' as const,
      options: ['Beginner (0-1 years)', 'Intermediate (2-3 years)', 'Advanced (4-5 years)', 'Expert (5+ years)'],
      correctAnswer: 1,
      points: 20,
    });
  }
  for (let i = 0; i < Math.min(requirements.length, Math.max(1, 3 - questions.length)); i++) {
    questions.push({
      id: `req_${i + 1}`,
      question: `How would you approach: ${requirements[i]}?`,
      type: 'short-answer' as const,
      points: 20,
    });
  }
  if (questions.length < 5) {
    questions.push({
      id: 'general_1',
      question: `Why are you interested in the ${job.title} position and what makes you a strong fit?`,
      type: 'short-answer' as const,
      points: 20,
    });
  }
  return questions;
}

import { registerMetricsRoutes } from './routes/metrics-api.js';
import { isResumeFileField } from './extension-fill-helpers.js';

export async function registerRoutes(app: Express): Promise<Express> {
  console.log('registerRoutes called!');
  registerMetricsRoutes(app);

  // Dev-only route for seeding the database - DISABLED in production
  app.post('/api/dev/seed', asyncHandler(async (req, res) => {
    // Only allow in development environment
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ message: "This endpoint is disabled in production" });
    }

    // Require a secret key even in development
    const devSecret = req.headers['x-dev-secret'];
    if (!process.env.DEV_SECRET || devSecret !== process.env.DEV_SECRET) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      await seedDatabase();
      res.status(200).json({ message: "Database seeded successfully" });
    } catch (error) {
      console.error("Error seeding database:", error);
      res.status(500).json({ message: "Failed to seed database" });
    }
  }));

  // Health check endpoint
  app.get('/api/health', asyncHandler(async (req, res) => {
    try {
      // Check database connectivity
      const isDbHealthy = await testDbConnection();
      
      if (!isDbHealthy) {
        return res.status(503).json({
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          version: process.env.npm_package_version || '1.0.0',
          checks: {
            database: 'unavailable'
          }
        });
      }

      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        checks: {
          database: 'connected'
        }
      });
    } catch (error) {
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        checks: {
          database: 'error'
        }
      });
    }
  }));

  // VPS watchdog: 200 while any cron has reported to pipeline_runs recently,
  // 503 once the freshest run is older than the threshold (i.e. the VPS cron
  // box is presumed dead). Polled by an external monitor (cron-job.org) that
  // emails on failure — the dead-man's switch for the whole cron fleet.
  // Deliberately minimal + unauthenticated: exposes only overall freshness,
  // not per-pipeline detail (that's /api/admin/pipeline-health).
  const WATCHDOG_MAX_AGE_HOURS = 26; // busiest cadence is daily; 26h absorbs schedule jitter
  app.get('/api/health/pipelines', asyncHandler(async (req, res) => {
    try {
      const result: any = await db.execute(sql`SELECT MAX(created_at) AS latest FROM pipeline_runs`);
      const rows: any[] = Array.isArray(result) ? result : (result?.rows ?? []);
      const latest = rows[0]?.latest ? new Date(rows[0].latest) : null;
      const ageHours = latest ? (Date.now() - latest.getTime()) / 3_600_000 : null;
      const fresh = ageHours !== null && ageHours <= WATCHDOG_MAX_AGE_HOURS;
      res.status(fresh ? 200 : 503).json({
        status: fresh ? 'fresh' : 'stale',
        lastPipelineRunAt: latest?.toISOString() ?? null,
        ageHours: ageHours !== null ? Math.round(ageHours * 10) / 10 : null,
        maxAgeHours: WATCHDOG_MAX_AGE_HOURS,
      });
    } catch (error) {
      res.status(503).json({ status: 'error' });
    }
  }));

  // ML Matching info endpoint
  app.get('/api/ml-matching/status', asyncHandler(async (req, res) => {
    try {
      const modelInfo = getModelInfo();
      res.json({
        status: 'available',
        ...modelInfo,
        note: 'Using open-source Xenova/all-MiniLM-L6-v2 model for semantic embeddings',
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        message: 'ML matching service unavailable',
      });
    }
  }));

  // Layoff news endpoint
  app.get('/api/news/layoffs', asyncHandler(async (req, res) => {
    try {
      const articles = await newsService.getLayoffNews();
      res.json(articles);
    } catch (error) {
      console.error("Error fetching layoff news:", error);
      res.status(500).json({ message: "Failed to fetch layoff news" });
    }
  }));

  // Helper function to format job match
  function formatJobMatch(job: any, index: number, aiExplanation?: string): any {
    return {
      id: index + 1,
      job: {
        ...job,
        id: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        workType: job.workType,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        description: job.description,
        requirements: job.requirements || [],
        skills: job.skills || [],
        aiCurated: job.source !== 'internal' && job.source !== 'platform',
        confidenceScore: job.matchScore,
        externalSource: job.source,
        externalUrl: job.externalUrl,
        careerPageUrl: job.careerPageUrl,
        postedDate: job.postedDate || job.createdAt,
        trustScore: job.trustScore ?? 0,
        livenessStatus: job.livenessStatus ?? 'unknown',
      },
      isVerifiedActive: job.isVerifiedActive ?? (job.livenessStatus === 'active' && (job.trustScore ?? 0) >= 90),
      isDirectFromCompany: job.isDirectFromCompany ?? ((job.trustScore ?? 0) >= 85),
      matchScore: job.matchScore != null ? `${job.matchScore}%` : 'N/A',
      matchTier: job.matchTier ?? (job.matchScore != null ? (job.matchScore >= 75 ? 'great' : job.matchScore >= 50 ? 'good' : 'worth-a-look') : null),
      confidenceLevel: job.confidenceLevel ?? (job.matchScore != null ? (job.matchScore > 80 ? 90 : job.matchScore > 60 ? 70 : 50) : null),
      skillMatches: job.skillMatches || [],
      partialSkillMatches: job.partialSkillMatches || [],
      scoreComponents: job.scoreComponents || undefined,
      matchReasons: job.skillMatches?.length > 0 ? job.skillMatches : undefined,
      aiExplanation: aiExplanation || job.aiExplanation,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
  }

  // AI-powered job matching — single DB query, scored in application code
  app.get('/api/ai-matches', isAuthenticated, asyncHandler(async (req: any, res) => {
    // 45s timeout — under Vercel's 60s maxDuration but well above prod cold-start observations.
    // Previously 20s, which prod was exceeding on cold start and swallowing into empty results.
    const TIMEOUT_MS = 45000;

    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Matching timeout')), TIMEOUT_MS);
    });
    const finish = () => clearTimeout(timeoutId);
    const startedAt = Date.now();

    try {
      const userId = req.user.id;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      // Matcher hard-caps recommendations at 100 (fetchScoredJobs slice), so the
      // client fetches the whole feed in one request and filters/paginates it
      // client-side. Cap mirrors that ceiling.
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      console.log(`[ai-matches] user=${userId} page=${page} limit=${limit}`);

      const filters = {
        jobTitle: (req.query.jobTitle as string) || undefined,
        location: (req.query.location as string) || undefined,
        workType: (req.query.workType as string) || undefined,
      };

      const result = await Promise.race([
        storage.getJobRecommendations(userId, filters, { page, limit }),
        timeoutPromise,
      ]) as { jobs: any[]; total: number; page: number; hasMore: boolean };

      finish();
      console.log(`[ai-matches] getJobRecommendations done in ${Date.now() - startedAt}ms (total=${result.total})`);

      // Track last feed visit on page 1 only (for "new" badges)
      if (page === 1) {
        db.execute(sql`UPDATE candidate_users SET last_feed_visit = NOW() WHERE user_id = ${userId}`)
          .catch(() => {});
      }

      // Get lastFeedVisit for "new" badge
      const [candidate] = await db.select({ lastFeedVisit: candidateProfiles.lastFeedVisit })
        .from(candidateProfiles)
        .where(eq(candidateProfiles.userId, userId))
        .limit(1);
      const lastVisit = candidate?.lastFeedVisit;

      const jobs = result.jobs.map((job: any, index: number) => {
        const match = formatJobMatch(job, (page - 1) * limit + index);
        return {
          ...match,
          isNew: lastVisit ? new Date(job.createdAt) > new Date(lastVisit) : false,
        };
      });

      console.log(`[ai-matches] page=${page}: ${jobs.length} of ${result.total} matches`);
      res.json({
        jobs,
        total: result.total,
        page: result.page,
        hasMore: result.hasMore,
      });
    } catch (error: any) {
      const elapsed = Date.now() - startedAt;
      console.error(`[ai-matches] Error after ${elapsed}ms:`, error?.message);
      finish();
      if (error?.message?.includes('timeout') || error?.message?.includes('cancel')) {
        const userId = req.user?.id;
        const reqPage = Math.max(1, parseInt(req.query.page as string) || 1);
        // On a matching timeout, serve the skill-relevant ATS discovery feed
        // instead of empty — empty makes the client drop to the external
        // aggregator fallback, which defeats the matched experience. Page 1 only
        // (the feed is a single page); guard with a short timeout so a struggling
        // function can't hang here too.
        if (userId && reqPage === 1) {
          try {
            const DISCOVERY_MS = 8000;
            let dTimer: NodeJS.Timeout;
            const dTimeout = new Promise<never>((_, rej) => {
              dTimer = setTimeout(() => rej(new Error('discovery timeout')), DISCOVERY_MS);
            });
            const discovery = await Promise.race([
              storage.getDiscoveryFeedForCandidate(userId),
              dTimeout,
            ]) as any[];
            clearTimeout(dTimer!);
            const jobs = discovery.map((job: any, index: number) => formatJobMatch(job, index));
            console.error(`[ai-matches][TIMEOUT] user=${userId} elapsed=${elapsed}ms — served ${jobs.length} discovery jobs`);
            return res.json({ jobs, total: jobs.length, page: 1, hasMore: false });
          } catch (fallbackErr: any) {
            console.error(`[ai-matches][TIMEOUT] user=${userId} elapsed=${elapsed}ms — discovery fallback failed (${fallbackErr?.message}), returning empty`);
          }
        }
        return res.json({ jobs: [], total: 0, page: 1, hasMore: false });
      }
      res.status(500).json({
        message: "Failed to generate job matches",
        details: process.env.NODE_ENV === 'development' ? error?.message : undefined
      });
    }
  }));

  // AI-powered screening questions
  app.post('/api/ai/screening-questions', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const { jobId, candidateId } = req.body;
      if (!jobId || !candidateId) {
        return res.status(400).json({ message: "jobId and candidateId are required" });
      }

      const job = await storage.getJobPosting(jobId);
      const candidate = await storage.getCandidateUser(candidateId);

      if (!job || !candidate) {
        return res.status(404).json({ message: "Job or Candidate not found" });
      }

      // Only the job owner can generate screening questions
      if (job.talentOwnerId !== req.user.id) {
        return res.status(403).json({ message: "Unauthorized: You do not own this job posting" });
      }

      const questions = await generateScreeningQuestions(candidate, job);
      res.json({ questions });
    } catch (error) {
      console.error("Error generating screening questions:", error);
      res.status(500).json({ message: "Failed to generate screening questions" });
    }
  }));

  // Universal job scraper with database persistence
  // In-memory response cache for /api/external-jobs.
  // Keyed by normalized query string; entries expire after 3 minutes.
  // On Vercel each invocation is stateless, but within a warm instance this
  // eliminates repeated DB round-trips for identical searches.
  const externalJobsCache = new Map<string, { jobs: any[]; ts: number }>();
  const EXTERNAL_JOBS_TTL_MS = 3 * 60 * 1000; // 3 minutes

  app.get('/api/external-jobs', asyncHandler(async (req, res) => {
    try {
      const skills = req.query.skills
        ? String(req.query.skills).split(',').filter(Boolean).slice(0, 20).map(s => s.slice(0, 100))
        : [];
      const jobTitle = req.query.jobTitle ? String(req.query.jobTitle).slice(0, 200) : undefined;
      const location = req.query.location ? String(req.query.location).slice(0, 200) : undefined;
      const rawWorkType = req.query.workType ? String(req.query.workType) : undefined;
      const VALID_WORK_TYPES = ['remote', 'hybrid', 'onsite'] as const;
      const workType = rawWorkType && (VALID_WORK_TYPES as readonly string[]).includes(rawWorkType)
        ? rawWorkType
        : undefined;

      const cacheKey = JSON.stringify({ skills: skills.sort(), jobTitle, location, workType });
      const cached = externalJobsCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < EXTERNAL_JOBS_TTL_MS) {
        // s-maxage drives Vercel's shared edge cache (the in-memory Map above is
        // per-lambda and almost never hits on serverless); stale-while-revalidate
        // is stripped by the edge unless s-maxage is present.
        res.set('Cache-Control', 'public, max-age=60, s-maxage=180, stale-while-revalidate=600');
        return res.json({ jobs: cached.jobs, cached: true, message: 'External jobs from cache' });
      }

      // Return external jobs from database (no live scraping)
      const externalJobs = await storage.getExternalJobs(skills, { jobTitle, location, workType });
      externalJobsCache.set(cacheKey, { jobs: externalJobs || [], ts: Date.now() });

      // triggerRefresh is only honoured for authenticated requests to prevent
      // unauthenticated callers from hammering the scrape pipeline (DOS risk)
      if (req.query.triggerRefresh === 'true' && (req as any).user) {
        const { externalJobsScheduler } = await import('./services/external-jobs-scheduler');
        externalJobsScheduler.triggerScrape()
          .catch(err => console.error('Background scrape trigger failed:', err?.message));
      }

      res.set('Cache-Control', 'public, max-age=60, s-maxage=180, stale-while-revalidate=600');
      res.json({
        jobs: externalJobs || [],
        cached: false,
        message: 'External jobs from database',
      });
    } catch (error) {
      console.error('Error fetching cached external jobs:', error);
      res.status(503).json({ jobs: [], cached: false, message: 'External jobs unavailable' });
    }
  }));

  // Aggregator fallback — shown ONLY in the candidate-feed empty state when
  // /api/ai-matches returns zero rows. Caller must badge these as leaving the
  // platform; URLs point to Adzuna/Jooble/etc., not the employer.
  app.get('/api/aggregator-fallback', asyncHandler(async (req, res) => {
    try {
      const skills = req.query.skills
        ? String(req.query.skills).split(',').filter(Boolean).slice(0, 20).map(s => s.slice(0, 100))
        : [];
      const jobTitle = req.query.jobTitle ? String(req.query.jobTitle).slice(0, 200) : undefined;
      const location = req.query.location ? String(req.query.location).slice(0, 200) : undefined;
      const rawWorkType = req.query.workType ? String(req.query.workType) : undefined;
      const VALID_WORK_TYPES = ['remote', 'hybrid', 'onsite'] as const;
      const workType = rawWorkType && (VALID_WORK_TYPES as readonly string[]).includes(rawWorkType)
        ? rawWorkType
        : undefined;

      const jobs = await storage.getAggregatorFallbackJobs(skills, { jobTitle, location, workType }, 10);
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ jobs });
    } catch (error) {
      console.error('Error fetching aggregator fallback:', error);
      res.status(503).json({ jobs: [] });
    }
  }));

  // Platform stats
  app.get('/api/platform/stats', asyncHandler(async (req, res) => {
    if (!db) return res.status(503).json({ message: 'Database not available' });
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Stats query timeout')), 15000)
      );
      const [userCount, jobCount, matchCount] = await Promise.race([
        Promise.all([
          db.select({ count: sql<number>`count(*)` }).from(users),
          db.select({ count: sql<number>`count(*)` }).from(jobPostings),
          db.select({ count: sql<number>`count(*)` }).from(jobApplications)
        ]),
        timeout
      ]) as any;
      const stats = {
        totalUsers: userCount[0].count || 0,
        totalJobs: jobCount[0].count || 0,
        totalMatches: matchCount[0].count || 0,
      };
      // s-maxage caches the good response at Vercel's shared edge so cold lambdas
      // don't re-run the COUNT(*) queries; stale-if-error keeps serving the last
      // good numbers when the origin hits the cold-connection timeout (503).
      res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600, stale-if-error=86400');
      res.json(stats);
    } catch (error) {
      console.error('Error fetching platform stats:', error);
      res.status(503).json({ message: 'Stats temporarily unavailable' });
    }
  }));

  // Auth routes

  // Extension login — proxies email/password to Supabase, returns JWT tokens.
  // No isAuthenticated middleware: this IS the sign-in endpoint.
  app.post('/api/auth/extension-login', asyncHandler(async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ message: 'email and password are required' });
      }

      const supabaseUrl  = process.env.SUPABASE_URL;
      const supabaseAnon = process.env.SUPABASE_ANON_KEY;
      if (!supabaseUrl || !supabaseAnon) {
        return res.status(503).json({ message: 'Auth service not configured' });
      }

      const sbRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseAnon,
        },
        body: JSON.stringify({ email, password }),
      });

      const sbBody = await sbRes.json() as any;

      if (!sbRes.ok) {
        const msg = sbBody?.error_description || sbBody?.message || 'Invalid credentials';
        return res.status(401).json({ message: msg });
      }

      return res.json({
        accessToken:  sbBody.access_token,
        refreshToken: sbBody.refresh_token,
        expiresAt:    Date.now() + (sbBody.expires_in ?? 3600) * 1000,
        user: {
          email: sbBody.user?.email,
          name:  sbBody.user?.user_metadata?.first_name
                  ? `${sbBody.user.user_metadata.first_name} ${sbBody.user.user_metadata.last_name || ''}`.trim()
                  : sbBody.user?.email,
        },
      });
    } catch (error) {
      console.error('Extension login error:', error);
      res.status(500).json({ message: 'Login failed' });
    }
  }));

  // Extension token refresh — exchanges a refresh token for a new access token
  app.post('/api/auth/extension-refresh', asyncHandler(async (req, res) => {
    try {
      const { refreshToken } = req.body || {};
      if (!refreshToken) {
        return res.status(400).json({ message: 'refreshToken is required' });
      }

      const supabaseUrl  = process.env.SUPABASE_URL;
      const supabaseAnon = process.env.SUPABASE_ANON_KEY;
      if (!supabaseUrl || !supabaseAnon) {
        return res.status(503).json({ message: 'Auth service not configured' });
      }

      const sbRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseAnon,
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      const sbBody = await sbRes.json() as any;

      if (!sbRes.ok) {
        const msg = sbBody?.error_description || sbBody?.message || 'Token refresh failed';
        return res.status(401).json({ message: msg });
      }

      return res.json({
        accessToken:  sbBody.access_token,
        refreshToken: sbBody.refresh_token,
        expiresAt:    Date.now() + (sbBody.expires_in ?? 3600) * 1000,
        user: {
          email: sbBody.user?.email,
          name:  sbBody.user?.user_metadata?.first_name
                  ? `${sbBody.user.user_metadata.first_name} ${sbBody.user.user_metadata.last_name || ''}`.trim()
                  : sbBody.user?.email,
        },
      });
    } catch (error) {
      console.error('Extension refresh error:', error);
      res.status(500).json({ message: 'Token refresh failed' });
    }
  }));

  // Extension form-fill — scrapes form fields from the page, uses AI to generate answers
  app.post('/api/extension/fill-form', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const { fields, jobContext, screenshot } = req.body || {};
      if (!fields || !Array.isArray(fields) || fields.length === 0) {
        return res.status(400).json({ message: 'fields array is required' });
      }
      if (fields.length > 50) {
        return res.status(400).json({ message: 'Too many fields (max 50)' });
      }

      // Load candidate data. This DB read is the one unguarded step that can throw
      // on a cold serverless→Postgres connection; race it against a timeout and
      // retry once so a transient cold-connection blip returns a retryable 503
      // (which the extension surfaces) instead of a generic 500.
      const loadCandidate = () => Promise.race([
        Promise.all([
          storage.getCandidateUser(req.user.id),
          storage.getUser(req.user.id),
        ]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Profile load timeout')), 12000)
        ),
      ]);
      let profile: any, user: any;
      try {
        [profile, user] = await loadCandidate();
      } catch (firstErr) {
        console.warn('[Extension] fill-form profile load failed, retrying:', (firstErr as Error).message);
        try {
          [profile, user] = await loadCandidate();
        } catch (secondErr) {
          console.error('[Extension] fill-form profile load failed twice:', (secondErr as Error).message);
          return res.status(503).json({
            error: 'service_temporarily_unavailable',
            message: 'Profile data temporarily unavailable, please retry',
            retryAfter: 3,
          });
        }
      }
      if (!profile) {
        return res.status(404).json({ message: 'No candidate profile found. Complete your profile first.' });
      }

      const parsed = (profile.resumeParsingData as any) || {};
      const personalInfo = parsed.personalInfo || {};

      // Build profile context
      const profileData: Record<string, string> = {
        firstName: profile.firstName || personalInfo.name?.split(' ')[0] || '',
        lastName: profile.lastName || personalInfo.name?.split(' ').slice(1).join(' ') || '',
        fullName: `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || personalInfo.name || '',
        email: profile.email || user?.email || personalInfo.email || '',
        phone: user?.phone_number || personalInfo.phone || '',
        linkedin: profile.linkedinUrl || personalInfo.linkedin || '',
        github: profile.githubUrl || personalInfo.github || '',
        portfolio: profile.portfolioUrl || profile.personalWebsite || personalInfo.portfolio || '',
        location: profile.location || personalInfo.location || '',
        currentTitle: parsed.experience?.positions?.[0]?.title || '',
        currentCompany: parsed.experience?.positions?.[0]?.company || '',
        school: parsed.education?.[0]?.institution || '',
        degree: parsed.education?.[0]?.degree || '',
        experienceYears: String(parsed.experience?.totalYears || ''),
      };

      const resumeContext = profile.resumeText
        ? profile.resumeText.slice(0, 3000)
        : profile.summary || parsed.summary || '';

      const skillsList = Array.isArray(profile.skills)
        ? (profile.skills as string[]).join(', ')
        : '';

      // Build the DOM field list for the LLM
      const fieldDescriptions = fields.map((f: any) =>
        `- id="${f.id}" type="${f.type}" label="${f.label || ''}" name="${f.name || ''}"${f.options ? ` options=[${f.options.join(', ')}]` : ''}${f.multiple ? ' MULTI-SELECT' : ''}${f.required ? ' REQUIRED' : ''}`
      ).join('\n');

      const candidateInfo = `NAME: ${profileData.fullName}
EMAIL: ${profileData.email}
PHONE: ${profileData.phone}
LOCATION: ${profileData.location}
LINKEDIN: ${profileData.linkedin}
GITHUB: ${profileData.github}
PORTFOLIO: ${profileData.portfolio}
CURRENT ROLE: ${profileData.currentTitle} at ${profileData.currentCompany}
EXPERIENCE: ${profileData.experienceYears} years
EDUCATION: ${profileData.degree} from ${profileData.school}
SKILLS: ${skillsList}

RESUME EXCERPT:
${resumeContext.slice(0, 2000)}`;

      const systemPrompt = `You are an expert at filling job application forms. You will receive:
1. A screenshot of a job application form (if available)
2. A list of DOM elements with their IDs, types, and labels
3. Candidate information to fill in

Your job: match each visible form field to the correct DOM element ID, then generate a fill action for each.

Return ONLY a valid JSON object with this structure:
{
  "actions": [
    { "fieldId": "dom_element_id", "action": "type", "value": "text to type" },
    { "fieldId": "select_id", "action": "select", "value": "exact option text" },
    { "fieldId": "custom_dropdown_id", "action": "click_then_type", "value": "search text" },
    { "fieldId": "file_input_id", "action": "upload_resume" },
    { "fieldId": "captcha_id", "action": "skip", "reason": "cannot fill captcha" }
  ]
}

GOAL: MAXIMUM COVERAGE. Return an action for EVERY field you can reasonably fill — do not stop at the obvious name/email fields. A field should be left out ONLY if it is genuinely impossible (CAPTCHA, signature pad, or data that cannot be inferred at all). Most real application forms should end up almost entirely filled.

Rules:
- fieldId MUST match an id from the DOM elements list exactly
- For standard text fields (name, email, phone, linkedin, github, portfolio): use the candidate's actual data. ALWAYS fill phone when a phone field exists and a phone number is available.
- Location-derived fields: derive Country / State / City / Address from the candidate's LOCATION. If a Country field exists and the location implies one, fill it.
- Education fields (school, university, degree, field of study, graduation/end year): fill from the candidate's education data.
- Compensation ("desired salary", "salary expectation", "expected compensation"): if the candidate has no explicit number, answer "Negotiable".
- "How did you hear about us" / referral source: answer "Company website" unless a better source is evident.
- For screening questions: write a professional, specific answer using the candidate's real experience. Keep under 200 words.
- VOLUNTARY self-identification / EEO / demographic fields (Gender, Race, Ethnicity, Hispanic/Latino, Veteran Status, Disability Status): these are almost always dropdowns with a decline choice. Return action "click_then_type" with value "Decline to self-identify" EVEN IF no options are listed (the options are often hidden until the dropdown opens). If options ARE listed with a different decline phrasing ("I don't wish to answer", "Prefer not to answer", "I do not wish to disclose"), use that exact option text instead. Do NOT skip EEO fields.
- Work AUTHORIZATION ("Are you legally authorized / eligible / do you have the right to work in [country]?", "Can you work in X without restriction?"): if the candidate's LOCATION is in that same country — or the question says "the country where this job is based" and the candidate's location matches the job's country (infer the job country from JOB CONTEXT / the form's Country field) — answer the AFFIRMATIVE option ("Yes"). People apply to jobs in countries where they can work, so a location match is strong evidence; do not leave these (usually REQUIRED) fields blank on a clear match. Answer "No" or skip only if there is explicit evidence the candidate is NOT authorized.
- Visa / SPONSORSHIP ("do you now or will you in the future require sponsorship?", "do you need a visa?"): this is genuinely ambiguous from location alone — answer only if the candidate data clearly supports it, otherwise skip rather than guess wrong.
- Other eligibility yes/no (citizenship, security clearance, willing to relocate): answer ONLY when the candidate data clearly supports it; if you cannot infer, skip rather than guess wrong (a wrong eligibility answer is worse than a blank one).
- MULTI-SELECT fields (marked "MULTI-SELECT" — the candidate may pick several options, e.g. "In what cities are you available to work?"): return a SINGLE action whose value is a PIPE-delimited list of every applicable option, e.g. value: "New York | Remote". Derive choices from the candidate's location and the job's location(s); include "Remote" when offered and appropriate. Use " | " ONLY to separate distinct options — never inside one option's text (e.g. keep "New York, NY" intact).
- For select/dropdown with native <select> type: use action "select" with value matching EXACTLY one of the provided options. Always pick the best-matching option rather than leaving it blank.
- For custom dropdowns (React Select, Combobox, etc. — type is usually "text"/"custom_select" but behaves like a dropdown; options may be provided): use "click_then_type" with the best-matching option text.
- For radio groups (type "radio" — ONE field carrying the question as its label plus every choice in options): use action "select" with value set to the EXACT option text that best answers the question. Treat them like single-choice dropdowns. Yes/No eligibility and EEO self-identification frequently appear as radio groups — apply the same eligibility and "Decline to self-identify" rules above, choosing the matching option text.
- For résumé/CV file upload fields: use action "upload_resume". For OTHER file uploads (cover letter, transcript, writing sample, portfolio, photo): use action "skip" — only the résumé is available, do NOT attach it to those.
- For fields you genuinely cannot fill (CAPTCHA, signature pads): use action "skip"
- For checkboxes that ask about consent/agreement to terms: use action "check"
- Acknowledgment / certification / privacy-consent fields rendered as a DROPDOWN (e.g. "I certify that the information provided is true…", "I understand my application will be processed in accordance with the Privacy Policy", "I agree to…"): these are affirmations the candidate must accept to apply. Select the affirmative option — match whichever of "Yes" / "I agree" / "I acknowledge" / "I understand" / "I certify" / "I accept" the field offers. Do NOT skip them; they are typically required.
- Do NOT fill fields that already have values unless they look incorrect
- If a field is not visible in the screenshot, still try to fill it based on its label/name`;

      const userPrompt = `CANDIDATE INFORMATION:
${candidateInfo}

JOB CONTEXT: ${(jobContext || 'Not available').slice(0, 1000)}

DOM FORM FIELDS:
${fieldDescriptions}

Analyze the form and return the actions JSON to fill every field you can.`;

      let actions: Array<{ fieldId: string; action: string; value?: string; reason?: string }> = [];

      try {
        let aiResponse: string;

        if (screenshot && isAIAvailable('image')) {
          // Vision path: send screenshot + DOM fields to a vision-capable provider
          console.log('[Extension] Using vision-powered fill with screenshot');
          aiResponse = await Promise.race([
            callAIWithImage(systemPrompt, userPrompt, screenshot, 'image/jpeg', {
              temperature: 0.2,
              maxOutputTokens: 4000,
            }),
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('Vision AI timeout')), 25000)
            ),
          ]);
        } else {
          // Text-only fallback
          console.log('[Extension] Using text-only fill (no screenshot)');
          aiResponse = await Promise.race([
            callAI(systemPrompt, userPrompt, {
              priority: 'medium',
              estimatedTokens: 2000,
              temperature: 0.2,
              maxOutputTokens: 4000,
            }),
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('AI timeout')), 15000)
            ),
          ]);
        }

        const parsed = JSON.parse(extractJsonObject(aiResponse));
        actions = parsed.actions || [];

        // Validate actions reference real field IDs
        const validIds = new Set(fields.map((f: any) => f.id));
        actions = actions.filter(a => validIds.has(a.fieldId));
      } catch (aiErr) {
        console.warn('[Extension] AI form-fill failed:', (aiErr as Error).message);
        // Fallback: build basic actions from profile pattern matching
        actions = buildFallbackActions(fields, profileData);
      }

      // Merge deterministic fallbacks for any fillable field the model OMITTED.
      // Observed on real forms: even with a MAXIMUM-COVERAGE prompt the model
      // nondeterministically drops obvious fields (phone, Country, Degree, an
      // acknowledgment dropdown) from run to run, so coverage swings. The regex
      // fallback backfills those without overriding anything the model did answer.
      try {
        const covered = new Set(actions.map(a => a.fieldId));
        for (const fb of buildFallbackActions(fields, profileData)) {
          if (!covered.has(fb.fieldId)) { actions.push(fb); covered.add(fb.fieldId); }
        }
      } catch (mergeErr) {
        console.warn('[Extension] fallback merge failed:', (mergeErr as Error).message);
      }

      // Guard (both AI + fallback paths): the résumé must only attach to actual
      // résumé/CV file fields, never to cover-letter/transcript/other document
      // uploads — otherwise the résumé gets submitted as the candidate's cover letter.
      const fieldsById = new Map(fields.map((f: any) => [f.id, f]));
      actions = actions.filter(a =>
        a.action !== 'upload_resume' || isResumeFileField(fieldsById.get(a.fieldId))
      );

      // Include resume URL for upload_resume actions (best-effort: a signed-URL
      // failure must not discard the form-fill actions we already computed)
      let resumeUrl: string | null = null;
      if (profile.resumeUrl) {
        try {
          const signedUrl = await storage.getResumeSignedUrl(profile.resumeUrl);
          resumeUrl = signedUrl || null;
        } catch (urlErr) {
          console.warn('[Extension] Resume signed-URL failed, returning actions without it:', (urlErr as Error).message);
        }
      }

      res.json({ actions, resumeUrl });
    } catch (error) {
      console.error('Extension fill-form error:', error);
      res.status(500).json({ message: 'Failed to generate form values' });
    }
  }));

  // Open-weights models often wrap the JSON in ```json fences or add prose
  // around it. A raw JSON.parse then throws and we needlessly drop a perfectly
  // good AI response to the regex fallback. Strip fences and extract the
  // outermost {...} object so the AI path actually survives.
  function extractJsonObject(s: string): string {
    if (!s) return '{}';
    let t = String(s).trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1);
    return t;
  }

  // Fallback: regex-based pattern matching when AI is unavailable
  function buildFallbackActions(
    fields: Array<{ id: string; label?: string; name?: string; type?: string; options?: string[] }>,
    profileData: Record<string, string>
  ) {
    // A candidate location is US if it says so explicitly OR ends in a US state
    // (name or 2-letter code, e.g. "Seattle, WA") — most profiles store "City, ST",
    // not "United States", so a bare "united states" check misses almost everyone.
    const US_STATE_CODE = /,\s*(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/;
    const US_STATE_NAME = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;
    const isUSLocation = (loc: string) =>
      /\b(usa|u\.?s\.?a?|united states|america)\b/i.test(loc) || US_STATE_CODE.test(loc) || US_STATE_NAME.test(loc);

    const PATTERNS: Record<string, RegExp[]> = {
      firstName: [/first[\s_-]?name/i, /fname/i, /given[\s_-]?name/i],
      lastName: [/last[\s_-]?name/i, /lname/i, /surname/i, /family[\s_-]?name/i],
      fullName: [/^full[\s_-]?name$/i, /^name$/i, /^your[\s_-]?name$/i],
      email: [/e[\s_-]?mail/i],
      phone: [/phone/i, /telephone/i, /mobile/i, /cell/i],
      linkedin: [/linkedin/i],
      github: [/github/i],
      portfolio: [/portfolio/i, /personal[\s_-]?site/i, /^website$/i],
      location: [/^location$/i, /^city$/i, /^address$/i],
      currentTitle: [/current[\s_-]?title/i, /job[\s_-]?title/i, /^title$/i],
      currentCompany: [/current[\s_-]?(company|employer)/i, /^company$/i],
      school: [/school/i, /university/i, /institution/i, /college/i],
      degree: [/degree/i, /education/i],
    };

    const actions: Array<{ fieldId: string; action: string; value?: string }> = [];

    for (const field of fields) {
      const searchText = `${field.label || ''} ${field.name || ''} ${field.id || ''}`.toLowerCase();

      if (field.type === 'file') {
        if (isResumeFileField(field)) {
          actions.push({ fieldId: field.id, action: 'upload_resume' });
        }
        continue;
      }

      for (const [key, patterns] of Object.entries(PATTERNS)) {
        if (patterns.some(p => p.test(searchText)) && profileData[key]) {
          actions.push({
            fieldId: field.id,
            action: field.type === 'select' ? 'select' : 'type',
            value: profileData[key],
          });
          break;
        }
      }

      // Type-based fallbacks
      if (!actions.find(a => a.fieldId === field.id)) {
        if (field.type === 'email' && profileData.email) {
          actions.push({ fieldId: field.id, action: 'type', value: profileData.email });
        } else if (field.type === 'tel' && profileData.phone) {
          actions.push({ fieldId: field.id, action: 'type', value: profileData.phone });
        }
      }

      // Higher-coverage fallbacks — mirror the AI prompt's safe defaults so the
      // regex path (used whenever the AI call fails) isn't stuck at name/email.
      if (!actions.find(a => a.fieldId === field.id) && field.type !== 'file') {
        const opts = field.options || [];
        const declineOpt = opts.find(o => /decline|prefer not|opt out|rather not|do(?:\s+not|n'?t)\s+(?:wish|want)|(?:wish|want)\s+not to/i.test(o));
        const customAction = field.type === 'select' ? 'select' : 'click_then_type';

        if (/salary|compensation|expected pay|desired pay/i.test(searchText)) {
          actions.push({ fieldId: field.id, action: field.type === 'select' ? 'select' : 'type', value: 'Negotiable' });
        } else if (/gender|race|ethnic|hispanic|latino|veteran|disability/i.test(searchText)) {
          // Voluntary EEO / self-identification: decline. Use a listed decline
          // option if present, else the standard phrasing (the option list is
          // usually hidden until the dropdown is opened).
          actions.push({ fieldId: field.id, action: field.type === 'select' ? 'select' : 'click_then_type', value: declineOpt || 'Decline to self-identify' });
        } else if (/\bcountry\b/i.test(searchText) && isUSLocation(profileData.location || '')) {
          actions.push({ fieldId: field.id, action: customAction, value: 'United States' });
        } else if (/how did you hear|referral source|^source$/i.test(searchText)) {
          actions.push({ fieldId: field.id, action: field.type === 'select' ? 'select' : 'type', value: 'Company website' });
        } else if ((field.type === 'custom_select' || field.type === 'select') && /\b(i )?(confirm|acknowledge|certify|consent|i agree|understand that|are aware|have read)\b/i.test(searchText)) {
          // Acknowledgment / certification dropdowns ("Please confirm you are aware…")
          // require an affirmative to apply. Pick a listed affirmative option if
          // known, else "Yes" — the client maps yes/agree/confirm families and will
          // take a lone option (e.g. "Confirmed") when that's all that's offered.
          const affirmOpt = opts.find(o => /^(yes|i agree|agree|i acknowledge|acknowledge|i understand|understand|i certify|certify|i accept|accept|confirm(ed)?)\b/i.test(o));
          actions.push({ fieldId: field.id, action: customAction, value: affirmOpt || 'Yes' });
        }
      }
    }

    return actions;
  }

  app.get('/api/auth/user', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      if (!req.user) {return res.status(401).json({ message: "Unauthorized" });}
      // Fetch user + candidate profile in parallel to eliminate sequential round-trip
      const [user, candidateProfile] = await Promise.all([
        storage.getUser(req.user.id),
        storage.getCandidateUser(req.user.id).catch(() => null),
      ]);
      if (!user) {return res.status(404).json({ message: "User not found" });}
      res.json({ ...user, candidateProfile: candidateProfile || null });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  }));

  // Sync Supabase auth user into local DB (called after signup/login)
  // For new users: requires a valid invite code (early access gate).
  // Existing users pass through without a code.
  app.post('/api/auth/sync', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      if (!req.user) {return res.status(401).json({ message: "Unauthorized" });}
      const isNew = !(await storage.getUser(req.user.id));

      // Early access gate: new users must provide a valid invite code.
      // Validate only — redemption happens AFTER upsertUser below, because
      // invite_code_redemptions has a FK to users.id and the row does not exist
      // yet. Redeeming here burned a use and then 403'd on the FK failure.
      let redeemedCode: string | undefined;
      let pendingInvite: any = null;
      if (isNew) {
        const inviteCode = req.body?.inviteCode || req.headers['x-invite-code'];
        if (!inviteCode) {
          return res.status(403).json({ message: 'Invite code required', code: 'INVITE_REQUIRED' });
        }
        const role = req.user.user_metadata?.role || 'candidate';
        const result = await storage.validateInviteCode(inviteCode, role);
        if (!result.valid) {
          return res.status(403).json({ message: result.error, code: 'INVITE_INVALID' });
        }
        pendingInvite = result.invite;
        redeemedCode = pendingInvite.code;
      }

      // Derive signup source from invite code prefix (e.g. REDDIT-A1B2 → reddit)
      const signupSource = redeemedCode
        ? redeemedCode.split('-')[0].toLowerCase()
        : undefined;

      const user = await storage.upsertUser({
        id: req.user.id,
        email: req.user.email || '',
        name: req.user.email || req.user.id,
        emailVerified: true,
        ...(isNew && redeemedCode ? { invite_code_used: redeemedCode, signup_source: signupSource } : {}),
      });
      // Safe to consume now that the user row exists.
      if (pendingInvite) {
        await storage.redeemInviteCode(pendingInvite, req.user.id);
      }
      if (isNew && req.user.email) {
        serverTrack(req.user.id, 'signup_completed', { role: req.user.user_metadata?.role, source: signupSource });
        sendWelcomeEmail(req.user.email, req.user.user_metadata?.first_name).catch((err: Error) =>
          console.error("Failed to send welcome email:", err)
        );
      }
      res.json({ success: true, user });
    } catch (error) {
      console.error("Error syncing user:", error);
      res.status(500).json({ message: "Failed to sync user" });
    }
  }));

  app.post('/api/auth/role', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      if (!req.user) {return res.status(401).json({ message: "Unauthorized" });}
      const { role } = req.body;
      if (!['candidate', 'talent_owner'].includes(role)) {return res.status(400).json({ message: "Invalid role" });}

      // Early access gate: if user is not yet in local DB, they must have an invite code
      const existingUser = await storage.getUser(req.user.id);
      let roleRedeemedCode: string | undefined;
      let rolePendingInvite: any = null;
      if (!existingUser) {
        const inviteCode = req.body?.inviteCode || req.headers['x-invite-code'];
        if (!inviteCode) {
          return res.status(403).json({ message: 'Invite code required', code: 'INVITE_REQUIRED' });
        }
        // Validate only; redeem after upsertUser (see /api/auth/sync).
        const result = await storage.validateInviteCode(inviteCode, role);
        if (!result.valid) {
          return res.status(403).json({ message: result.error, code: 'INVITE_INVALID' });
        }
        rolePendingInvite = result.invite;
        roleRedeemedCode = rolePendingInvite.code;
      }

      // Ensure user exists in local DB before updating role (Supabase Auth doesn't auto-sync)
      const roleSignupSource = roleRedeemedCode
        ? roleRedeemedCode.split('-')[0].toLowerCase()
        : undefined;
      await storage.upsertUser({
        id: req.user.id,
        email: req.user.email || '',
        name: req.user.email || req.user.id,
        emailVerified: true,
        ...(!existingUser && roleRedeemedCode ? { invite_code_used: roleRedeemedCode, signup_source: roleSignupSource } : {}),
      });
      // Safe to consume now that the user row exists.
      if (rolePendingInvite) {
        await storage.redeemInviteCode(rolePendingInvite, req.user.id);
      }
      const updatedUser = await storage.updateUserRole(req.user.id, role);

      if (role === 'talent_owner' && req.user.email) {
        const firstName = req.user.user_metadata?.first_name;
        sendTransactionalEmail({
          to: req.user.email,
          subject: 'Welcome to Recrutas — post your first job',
          html: employerWelcomeEmail(firstName),
        }).catch((err: Error) => console.error('[Email] employer welcome failed:', err));
      }

      res.json({ success: true, user: updatedUser });
    } catch (error) {
      console.error("Error setting user role:", error);
      res.status(500).json({ message: "Failed to set user role" });
    }
  }));

  // Candidate profile
  app.get('/api/candidate/profile', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      // Add timeout to prevent hanging on database connection issues
      // 15s timeout allows for serverless cold starts + DB connection time
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Profile fetch timeout')), 15000)
      );

      const profile = await Promise.race([
        storage.getCandidateUser(req.user.id),
        timeoutPromise
      ]) as any;

      // Return null for new users (no profile yet) - not an error
      if (!profile) {
        return res.json({ exists: false, profile: null });
      }

      res.json({ exists: true, profile });
    } catch (error: any) {
      console.error("Error fetching candidate profile:", error?.message);

      // Return a 503 Service Unavailable error on timeout
      if (error?.message?.includes('timeout') || error?.message?.includes('cancel')) {
        console.warn(`Profile fetch timeout for user ${req.user.id}`);
        return res.status(503).json({
          error: 'service_temporarily_unavailable',
          message: 'Profile data temporarily unavailable',
          retryAfter: 3
        });
      }

      res.status(500).json({ message: "Failed to fetch profile" });
    }
  }));

  app.post('/api/candidate/profile', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const profileData = insertCandidateProfileSchema.parse({ ...req.body, userId: req.user.id });
      const profile = await storage.upsertCandidateUser(profileData);
      
      await storage.updateUserInfo(req.user.id, { profile_complete: true });
      
      res.json(profile);
    } catch (error) {
      console.error("Error updating candidate profile:", error);
      res.status(500).json({ message: "Failed to update profile" });
    }
  }));

  app.post('/api/candidate/profile/complete', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const { skills } = req.body;
      
      const profileData: any = { userId: req.user.id };
      if (skills && Array.isArray(skills)) {
        profileData.skills = skills;
      }
      
      await storage.upsertCandidateUser(profileData);
      await storage.updateUserInfo(req.user.id, { profile_complete: true });
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error completing candidate profile:", error);
      res.status(500).json({ message: "Failed to complete profile" });
    }
  }));

  app.put('/api/candidate/preferences', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const { jobPreferences } = req.body;
      if (!jobPreferences || typeof jobPreferences !== 'object') {
        return res.status(400).json({ message: 'jobPreferences object required' });
      }
      await storage.upsertCandidateUser({ userId: req.user.id, jobPreferences });
      res.json({ success: true });
    } catch (error) {
      console.error('Error saving preferences:', error);
      res.status(500).json({ message: 'Failed to save preferences' });
    }
  }));

  // Get job statistics (for monitoring)
  app.get('/api/job-stats', asyncHandler(async (req: any, res) => {
    try {
      const stats = await storage.getJobStatistics();
      res.json(stats);
    } catch (error: any) {
      console.error("Error fetching job stats:", error?.message);
      res.status(500).json({ message: "Failed to fetch statistics" });
    }
  }));

  // Get signed URL for resume (secure access)
  app.get('/api/resume/:resumePath', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const resumePath = decodeURIComponent(req.params.resumePath);
      const normalizedPath = path.posix.normalize(resumePath);
      if (normalizedPath.includes('..') ||
          (!normalizedPath.startsWith(`resumes/${req.user.id}/`) && !normalizedPath.startsWith(`${req.user.id}/`))) {
        return res.status(403).json({ message: "Not authorized to access this resume" });
      }
      const signedUrl = await storage.getResumeSignedUrl(resumePath);
      res.json({ url: signedUrl });
    } catch (error) {
      console.error("Error generating resume URL:", error);
      res.status(500).json({ message: "Failed to generate resume URL" });
    }
  }));

  // Resume upload
  // NOTE: multer errors (wrong type, file too large) must be caught explicitly —
  // Express default error handler returns 500 for them. Use callback form instead.
  app.post('/api/candidate/resume', isAuthenticated, (req: any, res: any, next: any) => {
    upload.single('resume')(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ message: 'File too large. Maximum size is 4MB.' });
        }
        // fileFilter rejection or other multer error → 400
        return res.status(400).json({ message: err.message || 'File upload rejected.' });
      }
      next();
    });
  }, asyncHandler(async (req: any, res) => {
    try {
      // Daily limit: 3 resume uploads per day (admins exempt)
      if (!isAdminUser(req)) {
        const limitCheck = await storage.checkDailyLimit(req.user.id, 'resume_upload', 3);
        if (!limitCheck.allowed) {
          return res.status(429).json({ message: `Resume upload limit reached (${limitCheck.limit}/day). Try again tomorrow.` });
        }
      }

      if (!req.file) {
        console.error("Resume upload error: No file uploaded or file too large/wrong type.");
        return res.status(400).json({ message: "No file uploaded or file too large/wrong type" });
      }

      // Validate file magic bytes
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!validateFileSignature(req.file.buffer, ext)) {
        console.error("Resume upload error: File content does not match extension");
        return res.status(400).json({ message: "Invalid file: content does not match file type" });
      }

      console.log("Received file:", {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
      });
      const result = await resumeService.uploadAndProcessResume(req.user.id, req.file.buffer, req.file.mimetype);
      await storage.incrementDailyUsage(req.user.id, 'resume_upload');
      serverTrack(req.user.id, 'resume_parsed', { success: true, mimetype: req.file.mimetype });
      res.json(result);
    } catch (error) {
      console.error("Error processing resume upload:", error);
      if (res.headersSent) return;
      if (error instanceof ResumeProcessingError) {
        return res.status(500).json({
          message: error.message,
          details: process.env.NODE_ENV === 'development' ? error.originalError?.message : undefined
        });
      }
      return res.status(500).json({
        message: "Failed to upload resume",
        details: process.env.NODE_ENV === 'development' ? (error as Error)?.message : undefined
      });
    }
  }));

  // Candidate specific stats
  app.get('/api/candidate/stats', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const stats = await storage.getCandidateStats(req.user.id);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching candidate stats:", error);
      res.status(500).json({ message: "Failed to fetch candidate stats" });
    }
  }));

  // Candidate activity
  app.get('/api/candidate/activity', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const activity = await storage.getActivityLogs(req.user.id);
      res.json(activity);
    } catch (error) {
      console.error("Error fetching candidate activity:", error);
      res.status(500).json({ message: "Failed to fetch candidate activity" });
    }
  }));

  // Candidate applications
  app.get('/api/candidate/applications', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const applications = await storage.getApplicationsWithStatus(req.user.id);
      res.json(applications);
    } catch (error) {
      console.error("Error fetching candidate applications:", error);
      res.status(500).json({ message: "Failed to fetch candidate applications" });
    }
  }));

  // Get saved jobs for a candidate
  app.get('/api/candidate/saved-jobs', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const savedJobIds = await storage.getSavedJobIds(req.user.id);
      if (savedJobIds.length === 0) {
        return res.json([]);
      }
      
      // Fetch full job details for saved jobs
      const { db } = await import('./db.js');
      const { jobPostings } = await import('../shared/schema.js');

      const savedJobs = await db
        .select()
        .from(jobPostings)
        .where(inArray(jobPostings.id, savedJobIds));
      
      res.json(savedJobs);
    } catch (error) {
      console.error("Error fetching saved jobs:", error);
      res.status(500).json({ message: "Failed to fetch saved jobs" });
    }
  }));

  // Save a job for a candidate
  app.post('/api/candidate/saved-jobs', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const { jobId } = req.body;
      if (!jobId) {
        return res.status(400).json({ message: "jobId is required" });
      }
      await storage.saveJob(req.user.id, jobId);

      recordSignal(req.user.id, jobId, 'save');

      res.status(201).json({ message: "Job saved successfully" });
    } catch (error) {
      console.error("Error saving job:", error);
      res.status(500).json({ message: "Failed to save job" });
    }
  }));

  // Unsave a job for a candidate
  app.delete('/api/candidate/saved-jobs/:jobId', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const jobId = parseIntParam(req.params.jobId);
      if (!jobId) {return res.status(400).json({ message: "Invalid jobId" });}
      await storage.unsaveJob(req.user.id, jobId);
      res.status(200).json({ message: "Job unsaved successfully" });
    } catch (error) {
      console.error("Error unsaving job:", error);
      res.status(500).json({ message: "Failed to unsave job" });
    }
  }));

  // Hide a job for a candidate
  app.post('/api/candidate/hidden-jobs', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const { jobId } = req.body;
      if (!jobId) {
        return res.status(400).json({ message: "jobId is required" });
      }
      await storage.hideJob(req.user.id, jobId);

      recordSignal(req.user.id, jobId, 'hide');

      res.status(201).json({ message: "Job hidden successfully" });
    } catch (error) {
      console.error("Error hiding job:", error);
      res.status(500).json({ message: "Failed to hide job" });
    }
  }));

  // Get all job actions for a candidate
  app.get('/api/candidate/job-actions', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const savedJobIds = await storage.getSavedJobIds(req.user.id);
      const applications = await storage.getApplicationsForCandidate(req.user.id);
      const appliedJobIds = applications.map(app => app.jobId);

      res.json({
        saved: savedJobIds,
        applied: appliedJobIds,
      });
    } catch (error) {
      console.error("Error fetching job actions:", error);
      res.status(500).json({ message: "Failed to fetch job actions" });
    }
  }));

  // Candidate can update their own application status (for external jobs)
  app.put('/api/candidate/application/:applicationId/status', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const { status } = req.body;
      if (!status) {return res.status(400).json({ message: "Status is required" });}

      const VALID_CANDIDATE_STATUSES = ['submitted', 'screening', 'interview_scheduled', 'offer', 'rejected', 'withdrawn'];
      if (!VALID_CANDIDATE_STATUSES.includes(status)) {
        return res.status(400).json({ message: `Invalid status. Must be one of: ${VALID_CANDIDATE_STATUSES.join(', ')}` });
      }
      
      const applicationId = parseIntParam(req.params.applicationId);
      if (!applicationId) {return res.status(400).json({ message: "Invalid applicationId" });}
      
      // Verify the application belongs to this candidate
      const application = await storage.getApplicationById(applicationId);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }
      if (application.candidateId !== req.user.id) {
        return res.status(403).json({ message: "Unauthorized" });
      }
      
      // Update the status
      const updatedApplication = await storage.updateApplicationStatusByCandidate(applicationId, status);
      res.json(updatedApplication);
    } catch (error) {
      console.error("Error updating application status:", error);
      res.status(500).json({ message: "Failed to update application status" });
    }
  }));

  // Clear (delete) the candidate's past/closed applications (rejected + withdrawn)
  app.delete('/api/candidate/applications/closed', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const deletedCount = await storage.deleteClosedApplicationsByCandidate(req.user.id);
      res.json({ deletedCount });
    } catch (error) {
      console.error("Error clearing past applications:", error);
      res.status(500).json({ message: "Failed to clear past applications" });
    }
  }));

  // Job application
  app.post('/api/candidate/apply/:jobId', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const userId = req.user.id;
      const jobId = parseIntParam(req.params.jobId);
      if (!jobId) {return res.status(400).json({ message: "Invalid jobId" });}

      // Daily limit: 20 applications per day (admins exempt)
      if (!isAdminUser(req)) {
        const limitCheck = await storage.checkDailyLimit(userId, 'application', 20);
        if (!limitCheck.allowed) {
          return res.status(429).json({ message: `Application limit reached (${limitCheck.limit}/day). Try again tomorrow.` });
        }
      }

      const job = await storage.getJobPosting(jobId);
      if (!job) {
        return res.status(404).json({ message: "Job not found" });
      }

      // Check if it's an internal/platform job (not external)
      const isInternalJob = !job.externalUrl && (job.source === 'platform' || job.source === 'internal' || !job.source);

      let applicationMetadata = undefined;

      // Only store professional links for internal jobs
      if (isInternalJob) {
        const candidateProfile = await storage.getCandidateUser(userId);
        applicationMetadata = {
          linkedinUrl: (candidateProfile as any)?.linkedinUrl,
          githubUrl: (candidateProfile as any)?.githubUrl,
          portfolioUrl: (candidateProfile as any)?.portfolioUrl,
        };
      }

      // Atomic duplicate check + insert inside transaction
      const application = await db.transaction(async (tx: any) => {
        const [existing] = await tx.select().from(jobApplications)
          .where(sql`${jobApplications.jobId} = ${jobId} AND ${jobApplications.candidateId} = ${userId}`);
        if (existing) throw new Error('DUPLICATE_APPLICATION');
        const [created] = await tx.insert(jobApplications).values({
          jobId,
          candidateId: userId,
          status: isInternalJob && job.hasExam ? 'pending_exam' : 'submitted',
          metadata: applicationMetadata
        }).returning();
        return created;
      });
      if (!application) {return res.status(500).json({ message: "Failed to create application" });}

      await storage.incrementDailyUsage(userId, 'application');
      await storage.createActivityLog(userId, "job_applied", `Applied to job ID: ${jobId}`);

      serverTrack(userId, 'application_created', {
        job_id: jobId,
        application_id: application.id,
        is_internal: isInternalJob,
        has_exam: !!job.hasExam,
        company: job.company,
        source: job.source,
      });

      recordSignal(userId, jobId, 'apply', job);

      if (isInternalJob) {
        // Notify talent owner of new application
        const hasLinks = applicationMetadata?.linkedinUrl || applicationMetadata?.githubUrl || applicationMetadata?.portfolioUrl;
        await notificationService.createNotification({
          userId: job.talentOwnerId,
          type: 'new_application',
          title: 'New Application Received',
          message: `You have a new application for ${job.title}.${hasLinks ? ' Candidate has provided professional links.' : ''}`,
          relatedApplicationId: application.id,
        });

        // Email employer about new applicant
        storage.getUser(job.talentOwnerId).then(employer => {
          if (!employer?.email) return;
          const candidateProfile = applicationMetadata as any;
          const candidateName = candidateProfile?.firstName
            ? `${candidateProfile.firstName} ${candidateProfile.lastName || ''}`.trim()
            : 'A candidate';
          sendTransactionalEmail({
            to: employer.email,
            subject: `New applicant for ${job.title}`,
            html: employerNewApplicantEmail(
              (employer as any).name?.split(' ')[0],
              candidateName,
              job.title,
              !!job.hasExam,
              application.id,
            ),
          }).catch((err: Error) => console.error('[Email] new applicant failed:', err));
        }).catch(() => {});

        // Notify candidate their application was received (core promise: know where you stand)
        const examNote = job.hasExam ? ' Complete the screening exam to advance your application.' : '';
        await notificationService.createNotification({
          userId,
          type: 'application_submitted',
          title: 'Application Submitted',
          message: `Your application for ${job.title} at ${job.company} was received.${examNote}`,
          priority: 'medium',
          relatedApplicationId: application.id,
          data: { jobTitle: job.title, companyName: job.company, hasExam: job.hasExam }
        });
      }

      res.json(application);
    } catch (error: any) {
      if (error?.message === 'DUPLICATE_APPLICATION') {
        return res.status(400).json({ message: "Already applied to this job" });
      }
      console.error("Error applying to job:", error);
      res.status(500).json({ message: "Failed to apply to job" });
    }
  }));

  // Talent Owner routes
  app.get('/api/talent-owner/jobs', isAuthenticated, asyncHandler(async (req: any, res) => {
    if (!db) return res.status(503).json({ message: 'Database not available' });
    try {
      console.log(`[Talent Owner Jobs] Fetching jobs for user: ${req.user.id}`);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Jobs query timeout')), 8000)
      );
      const jobs = await Promise.race([
        storage.getJobPostings(req.user.id),
        timeout,
      ]);
      console.log(`[Talent Owner Jobs] Found ${jobs.length} jobs for user ${req.user.id}`);
      if (jobs.length > 0) {
        console.log(`[Talent Owner Jobs] Job IDs: ${jobs.map((j: any) => j.id).join(', ')}`);
      }
      res.json(jobs);
    } catch (error) {
      const msg = (error as Error).message;
      if (msg === 'Jobs query timeout') {
        console.warn('[Talent Owner Jobs] Query timed out for user:', req.user.id);
        return res.status(503).json({ message: 'Request timed out, please retry' });
      }
      console.error("Error fetching talent owner jobs:", error);
      res.status(500).json({ message: "Failed to fetch job postings" });
    }
  }));

  // Get all applicants across all jobs for a talent owner (for analytics)
  app.get('/api/talent-owner/all-applicants', isAuthenticated, asyncHandler(async (req: any, res) => {
    if (!db) return res.status(503).json({ message: 'Database not available' });
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Applicants query timeout')), 8000)
      );
      const candidates = await Promise.race([
        storage.getCandidatesForRecruiter(req.user.id),
        timeout,
      ]);
      // Transform to a flat applicant list
      const applicants = candidates.map((c: any) => ({
        applicationId: c.application.id,
        status: c.application.status,
        appliedAt: c.application.appliedAt,
        updatedAt: c.application.updatedAt || c.application.appliedAt,
        candidate: {
          id: c.candidate.id,
          firstName: c.candidate.firstName || c.candidate.first_name,
          lastName: c.candidate.lastName || c.candidate.last_name,
          email: c.candidate.email,
        },
        profile: {
          skills: c.profile?.skills || [],
          experience: c.profile?.experience,
          resumeUrl: c.profile?.resumeUrl,
        },
        job: {
          id: c.job.id,
          title: c.job.title,
          company: c.job.company,
        }
      }));
      res.json(applicants);
    } catch (error) {
      const msg = (error as Error).message;
      if (msg === 'Applicants query timeout') {
        console.warn('[All Applicants] Query timed out for user:', req.user.id);
        return res.status(503).json({ message: 'Request timed out, please retry' });
      }
      console.error("Error fetching all applicants:", error);
      res.status(500).json({ message: "Failed to fetch applicants" });
    }
  }));

  // Get talent owner profile
  app.get('/api/talent-owner/profile', isAuthenticated, asyncHandler(async (req: any, res) => {
    if (!db) return res.status(503).json({ message: 'Database not available' });
    try {
      const profile = await storage.getTalentOwnerProfile(req.user.id);
      res.json(profile || null);
    } catch (error) {
      console.error("Error fetching talent owner profile:", error);
      res.status(500).json({ message: "Failed to fetch profile" });
    }
  }));

  // Recruiter specific stats
  app.get('/api/recruiter/stats', isAuthenticated, asyncHandler(async (req: any, res) => {
    if (!db) return res.status(503).json({ message: 'Database not available' });
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Stats query timeout')), 8000)
      );
      const stats = await Promise.race([storage.getRecruiterStats(req.user.id), timeout]);
      res.json(stats);
    } catch (error) {
      const msg = (error as Error).message;
      if (msg === 'Stats query timeout') {
        console.warn('[Recruiter Stats] Query timed out for user:', req.user.id);
        return res.status(503).json({ message: 'Request timed out, please retry' });
      }
      console.error("Error fetching recruiter stats:", error);
      res.status(500).json({ message: "Failed to fetch recruiter stats" });
    }
  }));

  app.post('/api/jobs', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      // Daily limit: 5 job posts per day (admins exempt)
      if (!isAdminUser(req)) {
        const limitCheck = await storage.checkDailyLimit(req.user.id, 'job_post', 5);
        if (!limitCheck.allowed) {
          return res.status(429).json({ message: `Job posting limit reached (${limitCheck.limit}/day). Try again tomorrow.` });
        }
      }

      // Log request details for debugging job creation issues
      console.log('[Job Creation] Request:', {
        userId: req.user?.id,
        hasTitle: !!req.body?.title,
        hasCompany: !!req.body?.company,
        hasDescription: !!req.body?.description,
        hasSkills: !!req.body?.skills && Array.isArray(req.body.skills) && req.body.skills.length > 0,
        workType: req.body?.workType,
        bodyKeys: Object.keys(req.body || {})
      });

      const jobData = insertJobPostingSchema.parse({ ...req.body, talentOwnerId: req.user.id });
      console.log(`[Job Creation] Parsed job data with talentOwnerId: ${jobData.talentOwnerId}`);
      const job = await storage.createJobPosting(jobData);
      await storage.incrementDailyUsage(req.user.id, 'job_post');
      console.log(`[Job Creation] Successfully created job ID: ${job.id} for talent owner: ${job.talentOwnerId}`);

      // Return job IMMEDIATELY (within <100ms) before any async operations
      // All heavy processing happens in background to prevent timeouts
      res.status(201).json({
        ...job,
        examGenerated: false, // exam questions generate async in background
        message: "Job posted successfully! Processing in background..."
      });

      // Process everything asynchronously in background - fire and forget
      // This prevents timeouts when processing exams, matching candidates, etc.
      setTimeout(async () => {
        try {
          // Generate exam questions if needed
          if (job.hasExam) {
            try {
              const examData = {
                jobId: job.id,
                title: `${job.title} Assessment`,
                questions: await generateExamQuestions(job)
              };
              await storage.createJobExam(examData);
              console.log(`[Background] Exam generated for job ${job.id}`);
            } catch (examError) {
              console.warn(`[Background] Failed to generate exam for job ${job.id}:`, (examError as Error)?.message);
              // Continue - exam generation is not critical
            }
          }

          // Log activity in background
          await storage.createActivityLog(req.user.id, "job_posted", `Job posted: ${job.title}`);
          console.log(`[Background] Activity logged for job ${job.id}`);

          // Process candidate matching in background
          processJobMatchesInBackground(job.id);

          // Fire Inngest event to recompute embeddings + invalidate match cache
          const { sendInngestEvent } = await import('./inngest-service.js');
          await sendInngestEvent('match/recompute', { jobId: job.id, talentOwnerId: req.user.id });
        } catch (bgError) {
          console.error(`[Background] Error processing job ${job.id}:`, (bgError as Error)?.message);
        }
      }, 0);

    } catch (error) {
      console.error("[Job Creation] Error:", error);
      if (error instanceof z.ZodError) {
        const fieldErrors = error.flatten().fieldErrors;
        const errorSummary = Object.entries(fieldErrors)
          .map(([field, msgs]) => `${field}: ${(msgs as string[]).join(', ')}`)
          .join('; ');
        console.error("[Job Creation] Validation errors:", errorSummary);
        return res.status(400).json({
          message: `Validation failed: ${errorSummary}`,
          errors: fieldErrors,
        });
      }
      res.status(500).json({
        message: "Failed to create job posting",
        error: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined
      });
    }
  }));

  // Update job posting (PUT /api/jobs/:jobId)
  app.put('/api/jobs/:jobId', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const jobId = parseIntParam(req.params.jobId);
      if (!jobId) {return res.status(400).json({ message: "Invalid jobId" });}
      const userId = req.user.id;

      // Verify ownership
      const job = await storage.getJobPosting(jobId);
      if (!job || job.talentOwnerId !== userId) {
        return res.status(404).json({ message: 'Job not found' });
      }

      // Validate request body
      const validatedData = updateJobPostingSchema.parse(req.body);

      const updatedJob = await storage.updateJobPosting(jobId, userId, validatedData);
      await storage.createActivityLog(userId, "job_updated", `Job updated: ${updatedJob.title}`);
      res.json(updatedJob);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid job data",
          errors: error.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
        });
      }
      console.error("Error updating job posting:", error);
      res.status(500).json({ message: "Failed to update job posting" });
    }
  }));

  // Delete job posting (DELETE /api/jobs/:jobId)
  app.delete('/api/jobs/:jobId', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const jobId = parseIntParam(req.params.jobId);
      if (!jobId) {return res.status(400).json({ message: "Invalid jobId" });}
      const userId = req.user.id;

      // Verify ownership
      const job = await storage.getJobPosting(jobId);
      if (!job || job.talentOwnerId !== userId) {
        return res.status(404).json({ message: 'Job not found' });
      }

      await storage.deleteJobPosting(jobId, userId);
      await storage.createActivityLog(userId, "job_deleted", `Job deleted: ${job.title}`);
      res.json({ message: 'Job deleted successfully' });
    } catch (error) {
      console.error("Error deleting job posting:", error);
      res.status(500).json({ message: "Failed to delete job posting" });
    }
  }));

  // Update job status (pause/resume/close)
  app.patch('/api/jobs/:jobId/status', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const jobId = parseIntParam(req.params.jobId);
      if (!jobId) {return res.status(400).json({ message: "Invalid jobId" });}
      const userId = req.user.id;
      const { status, notifyCandidates } = req.body;

      if (!['active', 'paused', 'closed'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status. Must be active, paused, or closed.' });
      }

      // Verify ownership
      const job = await storage.getJobPosting(jobId);
      if (!job || job.talentOwnerId !== userId) {
        return res.status(404).json({ message: 'Job not found' });
      }

      const updatedJob = await storage.updateJobPosting(jobId, userId, { status });
      await storage.createActivityLog(userId, "job_status_changed", `Job status changed to ${status}: ${job.title}`);

      if (status === 'closed' && notifyCandidates) {
        await storage.closeJobAndNotifyCandidates(jobId, userId);
      }

      res.json(updatedJob);
    } catch (error) {
      console.error("Error updating job status:", error);
      res.status(500).json({ message: "Failed to update job status" });
    }
  }));

  app.post('/api/talent-owner/profile/complete', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const validated = completeTalentOwnerProfileSchema.parse(req.body);

      const {
        firstName,
        lastName,
        phoneNumber,
        jobTitle,
        companyName,
        companyWebsite,
        companySize,
        industry,
        companyLocation,
        companyDescription,
      } = validated;

      console.log(`[routes] Completing profile for talent owner ${req.user.id}`);

      // Update basic user info
      await storage.updateUserInfo(req.user.id, {
        first_name: firstName,
        last_name: lastName,
        phone_number: phoneNumber,
        profile_complete: true,
      });

      // Update/Create talent owner profile
      const updatedProfile = await storage.upsertTalentOwnerProfile({
        userId: req.user.id,
        jobTitle,
        companyName,
        companyWebsite,
        companySize,
        industry,
        companyLocation,
        companyDescription,
        profileComplete: true,
      });

      res.json({
        ...updatedProfile,
        firstName,
        lastName,
        phoneNumber,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid profile data",
          errors: error.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
        });
      }
      console.error("Error completing talent owner profile:", error);
      res.status(500).json({ message: "Failed to complete profile" });
    }
  }));


  app.get('/api/jobs/:jobId/applicants', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const jobId = parseIntParam(req.params.jobId);
      if (!jobId) {return res.status(400).json({ message: "Invalid jobId" });}
      const applicants = await storage.getApplicantsForJob(jobId, req.user.id);
      res.json(applicants);
    } catch (error) {
      console.error("Error fetching applicants:", error);
      res.status(500).json({ message: "Failed to fetch applicants" });
    }
  }));

  // Screening Questions API
  // Get screening questions for a job
  app.get('/api/jobs/:jobId/screening-questions', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const jobId = parseIntParam(req.params.jobId);
      if (!jobId) {return res.status(400).json({ message: "Invalid jobId" });}
      const questions = await storage.getScreeningQuestions(jobId);
      res.json(questions);
    } catch (error) {
      console.error("Error fetching screening questions:", error);
      res.status(500).json({ message: "Failed to fetch screening questions" });
    }
  }));

  // Create/Update screening questions for a job
  app.post('/api/jobs/:jobId/screening-questions', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const jobId = parseIntParam(req.params.jobId);
      if (!jobId) {return res.status(400).json({ message: "Invalid jobId" });}
      const userId = req.user.id;

      // Verify ownership
      const job = await storage.getJobPosting(jobId);
      if (!job || job.talentOwnerId !== userId) {
        return res.status(404).json({ message: 'Job not found' });
      }

      const { questions } = req.body;
      if (!Array.isArray(questions)) {
        return res.status(400).json({ message: 'Questions must be an array' });
      }

      const savedQuestions = await storage.saveScreeningQuestions(jobId, questions);
      res.json(savedQuestions);
    } catch (error) {
      console.error("Error saving screening questions:", error);
      res.status(500).json({ message: "Failed to save screening questions" });
    }
  }));

  // Submit screening answers for an application
  app.post('/api/applications/:applicationId/screening-answers', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const applicationId = parseIntParam(req.params.applicationId);
      if (!applicationId) {return res.status(400).json({ message: "Invalid applicationId" });}

      const [application] = await db.select({ candidateId: jobApplications.candidateId })
        .from(jobApplications).where(eq(jobApplications.id, applicationId));
      if (!application || application.candidateId !== req.user.id) {
        return res.status(403).json({ message: "Not authorized" });
      }

      const { answers } = req.body;

      if (!Array.isArray(answers)) {
        return res.status(400).json({ message: 'Answers must be an array' });
      }

      const savedAnswers = await storage.saveScreeningAnswers(applicationId, answers);
      res.json(savedAnswers);
    } catch (error) {
      console.error("Error saving screening answers:", error);
      res.status(500).json({ message: "Failed to save screening answers" });
    }
  }));

  app.get('/api/jobs/:jobId/discovery', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const jobId = parseIntParam(req.params.jobId);
      if (!jobId) {return res.status(400).json({ message: "Invalid jobId" });}
      const job = await storage.getJobPosting(jobId);

      if (!job || job.talentOwnerId !== req.user.id) {
        return res.status(403).json({ message: "Unauthorized to access this job's discovery" });
      }

      const matches = await storage.findMatchingCandidates(jobId);
      res.json(matches);
    } catch (error) {
      console.error("Error in job discovery:", error);
      res.status(500).json({ message: "Failed to fetch matching candidates" });
    }
  }));

  app.put('/api/applications/:applicationId/status', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const { status } = req.body;
      if (!status) {return res.status(400).json({ message: "Status is required." });}
      const VALID_APPLICATION_STATUSES = [
        'pending_exam', 'submitted', 'viewed', 'screening',
        'interview_scheduled', 'interview_completed', 'offer', 'rejected', 'withdrawn'
      ] as const;
      if (!(VALID_APPLICATION_STATUSES as readonly string[]).includes(status)) {
        return res.status(400).json({ message: `Invalid status. Must be one of: ${VALID_APPLICATION_STATUSES.join(', ')}` });
      }
      const applicationId = parseIntParam(req.params.applicationId);
      if (!applicationId) {return res.status(400).json({ message: "Invalid applicationId" });}
      const updatedApplication = await storage.updateApplicationStatus(applicationId, status, req.user.id);

      // Track AI event for status change
      try {
        await applicationIntelligence.trackApplicationEvent(
          req.params.applicationId,
          status as any,
          { role: 'recruiter', name: req.user.firstName || 'Recruiter' },
          { feedback: req.body.feedback || `Status updated to ${status}` }
        );
      } catch (error) {
        console.error("Error tracking application event:", error);
      }

      // Send richer notifications for terminal states
      if (status === 'accepted' || status === 'offer' || status === 'rejected') {
        try {
          const application = await storage.getApplicationById(applicationId);
          if (application) {
            const job = await storage.getJobPosting(application.jobId);
            
            if (status === 'accepted' || status === 'offer') {
              await notificationService.notifyApplicationAccepted(
                application.candidateId,
                job?.title || 'Unknown Job',
                job?.company || 'Unknown Company',
                applicationId
              );
            } else if (status === 'rejected') {
              await notificationService.notifyApplicationRejected(
                application.candidateId,
                job?.title || 'Unknown Job',
                job?.company || 'Unknown Company',
                applicationId
              );
            }
          }
        } catch (notifyError) {
          console.error("Error sending status notification:", notifyError);
        }
      }

      res.json(updatedApplication);
    } catch (error) {
      console.error("Error updating application status:", error);
      res.status(500).json({ message: "Failed to update status" });
    }
  }));

  app.post('/api/jobs/:jobId/exam/submit', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const jobId = parseIntParam(req.params.jobId);
      if (!jobId) { return res.status(400).json({ message: "Invalid jobId" }); }
      const { answers } = req.body;
      if (!answers || typeof answers !== 'object') {
        return res.status(400).json({ message: "Answers are required" });
      }
      const result = await examService.submitExam(jobId, req.user.id, answers);

      // Fire-and-forget: join exam score back to match signal
      joinExamScore(req.user.id, jobId, result.score).catch(() => {});

      res.json(result);
    } catch (error) {
      console.error("Error submitting exam:", error);
      const message = (error as Error).message;
      if (message === 'Exam already submitted for this job') {
        return res.status(409).json({ message });
      }
      res.status(500).json({ message: "Failed to submit exam" });
    }
  }));

  // Notification endpoints
  app.get('/api/notifications', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const notifications = await notificationService.getAllNotifications(req.user.id);
      res.json(notifications);
    } catch (error) {
      console.error("Error fetching notifications:", error);
      res.status(500).json({ message: "Failed to fetch notifications" });
    }
  }));

  app.get('/api/notifications/count', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const count = await notificationService.getUnreadCount(req.user.id);
      res.json({ count });
    } catch (error) {
      console.error("Error fetching notification count:", error);
      res.status(500).json({ message: "Failed to fetch notification count" });
    }
  }));

  app.post('/api/notifications/:id/read', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const notificationId = parseIntParam(req.params.id);
      if (!notificationId) {return res.status(400).json({ message: "Invalid notification id" });}
      await notificationService.markAsRead(notificationId, req.user.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error marking notification as read:", error);
      res.status(500).json({ message: "Failed to mark notification as read" });
    }
  }));

  app.post('/api/notifications/mark-all-read', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      await notificationService.markAllAsRead(req.user.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error marking all notifications as read:", error);
      res.status(500).json({ message: "Failed to mark all notifications as read" });
    }
  }));

  // Polling-based notification endpoints (Vercel serverless compatible)
  app.get('/api/notifications/poll', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const lastNotificationId = req.query.lastId ? parseInt(req.query.lastId as string) : undefined;
      const longPoll = req.query.longPoll === 'true';

      const result = await notificationService.pollNotifications(req.user.id, {
        lastNotificationId,
        longPoll,
        timeout: 25000 // 25 seconds max for Vercel
      });

      res.json(result);
    } catch (error) {
      console.error("Error polling notifications:", error);
      res.status(500).json({ message: "Failed to poll notifications" });
    }
  }));

  app.post('/api/notifications/subscribe', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const result = await notificationService.subscribePolling(req.user.id);
      res.json(result);
    } catch (error) {
      console.error("Error subscribing to notifications:", error);
      res.status(500).json({ message: "Failed to subscribe to notifications" });
    }
  }));

  app.post('/api/notifications/unsubscribe', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      await notificationService.unsubscribePolling(req.user.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error unsubscribing from notifications:", error);
      res.status(500).json({ message: "Failed to unsubscribe from notifications" });
    }
  }));

  app.get('/api/notifications/connection-status', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const status = await notificationService.getConnectionStatus(req.user.id);
      res.json(status);
    } catch (error) {
      console.error("Error getting connection status:", error);
      res.status(500).json({ message: "Failed to get connection status" });
    }
  }));

  // Interview scheduling endpoint
  app.post('/api/interviews/schedule', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const validated = scheduleInterviewSchema.parse(req.body);

      // Verify the talent owner has permission to schedule interviews for this job
      const job = await storage.getJobPosting(validated.jobId);
      if (!job || job.talentOwnerId !== req.user.id) {
        return res.status(403).json({ message: "Unauthorized to schedule interviews for this job" });
      }

      const interview = await storage.createInterview({
        candidateId: validated.candidateId,
        interviewerId: req.user.id,
        jobId: validated.jobId,
        applicationId: validated.applicationId,
        scheduledAt: validated.scheduledAt,
        duration: validated.duration || 60,
        platform: validated.platform || 'video',
        meetingLink: validated.meetingLink,
        notes: validated.notes,
      });

      // Notify the candidate about the scheduled interview
      const candidate = await storage.getCandidateUser(validated.candidateId);
      const formattedDate = new Date(validated.scheduledAt).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      await notificationService.notifyInterviewScheduled(
        validated.candidateId,
        job.company,
        job.title,
        formattedDate,
        validated.applicationId
      );

      res.json(interview);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid interview data",
          errors: error.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
        });
      }
      console.error("Error scheduling interview:", error);
      res.status(500).json({ message: "Failed to schedule interview" });
    }
  }));

  // Advanced matching endpoints
  app.get('/api/advanced-matches/:candidateId', isAuthenticated, asyncHandler(async (req: any, res) => {
    // Add timeout to prevent hanging
    const timeoutMs = 15000; // 15 second timeout
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Advanced matching timeout')), timeoutMs)
    );

    try {
      const { candidateId } = req.params;

      // Verify the user is requesting their own matches or is a talent owner
      const user = await storage.getUser(req.user.id);
      if (candidateId !== req.user.id && user?.role !== 'talent_owner') {
        return res.status(403).json({ message: "Unauthorized to view these matches" });
      }

      // Use the unified matching pipeline
      const result = await Promise.race([
        storage.getJobRecommendations(candidateId),
        timeoutPromise
      ]) as { jobs: any[]; total: number };

      res.json({ matches: result.jobs || [], total: result.total || 0, algorithm: 'skill-match-v2' });
    } catch (error: any) {
      console.error("Error fetching advanced matches:", error?.message);
      if (error?.message?.includes('timeout')) {
        return res.status(504).json({ message: "Match generation timed out", matches: [], total: 0 });
      }
      res.status(500).json({ message: "Failed to fetch advanced matches", matches: [], total: 0 });
    }
  }));

  app.put('/api/candidate/match-preferences', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const preferences = req.body;
      // Store preferences on the candidate profile — fetchScoredJobs reads them
      const { candidateProfiles } = await import('../shared/schema.js');
      await db.update(candidateProfiles)
        .set({ jobPreferences: preferences })
        .where(eq(candidateProfiles.userId, req.user.id));
      res.json({ success: true });
    } catch (error) {
      console.error("Error updating match preferences:", error);
      res.status(500).json({ message: "Failed to update match preferences" });
    }
  }));

  // Exam retrieval endpoint
  app.get('/api/jobs/:jobId/exam', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const jobId = parseIntParam(req.params.jobId);
      if (!jobId) {return res.status(400).json({ message: "Invalid jobId" });}
      const job = await storage.getJobPosting(jobId);

      if (!job) {
        return res.status(404).json({ message: "Job not found" });
      }

      if (!job.hasExam) {
        return res.status(404).json({ message: "This job does not have an exam" });
      }

      const exam = await storage.getJobExam(jobId);
      if (!exam) {
        return res.status(404).json({ message: "Exam not found for this job" });
      }

      // Candidate must have applied before accessing the exam
      const application = await storage.getApplicationByJobAndCandidate(jobId, req.user.id);
      if (!application) {
        return res.status(403).json({ message: "You must apply for this job before taking the exam" });
      }

      // Return exam without correct answers for candidates
      const examForCandidate = {
        id: exam.id,
        jobId: exam.jobId,
        title: exam.title,
        jobTitle: job.title,
        company: job.company,
        maxChatCandidates: job.maxChatCandidates || 5,
        questions: exam.questions.map((q: any) => ({
          id: q.id,
          question: q.question,
          type: q.type,
          options: q.options,
          points: q.points
          // Note: correctAnswer is intentionally omitted
        })),
        timeLimit: exam.timeLimit,
        passingScore: exam.passingScore
      };

      res.json(examForCandidate);
    } catch (error) {
      console.error("Error fetching exam:", error);
      res.status(500).json({ message: "Failed to fetch exam" });
    }
  }));

  // ==========================================
  // STRIPE SUBSCRIPTION ROUTES
  // ==========================================

  // Import Stripe service
  const { stripeService } = await import('./services/stripe.service');

  // Get subscription status
  app.get('/api/subscription/status', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const subscription = await stripeService.getUserSubscription(req.user.id);
      res.json(subscription);
    } catch (error) {
      console.error("Error fetching subscription status:", error);
      res.status(500).json({ message: "Failed to fetch subscription status" });
    }
  }));

  // Get available subscription tiers
  app.get('/api/subscription/tiers', asyncHandler(async (req, res) => {
    try {
      const tiers = await stripeService.getAvailableTiers();
      res.json(tiers);
    } catch (error) {
      console.error("Error fetching subscription tiers:", error);
      res.status(500).json({ message: "Failed to fetch subscription tiers" });
    }
  }));

  // Create checkout session (accepts tierName or tierId for backward compat)
  app.post('/api/stripe/create-checkout', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      if (!stripeService.isConfigured()) {
        return res.status(503).json({ message: "Payment system is not configured" });
      }

      const { tierName, tierId, billingCycle } = req.body;

      if (!billingCycle) {
        return res.status(400).json({ message: "Missing billingCycle" });
      }

      let checkoutUrl: string;
      if (tierName) {
        checkoutUrl = await stripeService.createCheckoutSessionByName(
          req.user.id,
          tierName,
          billingCycle
        );
      } else if (tierId) {
        checkoutUrl = await stripeService.createCheckoutSession(
          req.user.id,
          tierId,
          billingCycle
        );
      } else {
        return res.status(400).json({ message: "Missing tierName or tierId" });
      }

      res.json({ url: checkoutUrl });
    } catch (error: any) {
      console.error("Error creating checkout session:", error);
      res.status(500).json({ message: error.message || "Failed to create checkout session" });
    }
  }));

  // Create customer portal session
  app.post('/api/stripe/portal', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      if (!stripeService.isConfigured()) {
        return res.status(503).json({ message: "Payment system is not configured" });
      }

      const portalUrl = await stripeService.createPortalSession(req.user.id);
      res.json({ url: portalUrl });
    } catch (error: any) {
      console.error("Error creating portal session:", error);
      res.status(500).json({ message: error.message || "Failed to create portal session" });
    }
  }));

  // Check feature access
  app.get('/api/subscription/can-access/:feature', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const { feature } = req.params;
      const access = await stripeService.canAccessFeature(req.user.id, feature);
      res.json(access);
    } catch (error) {
      console.error("Error checking feature access:", error);
      res.status(500).json({ message: "Failed to check feature access" });
    }
  }));

  // Stripe webhook route is in index.ts (before express.json() for raw body verification)

  // Initialize default subscription tiers (admin endpoint) - DISABLED in production
  app.post('/api/admin/init-subscription-tiers', asyncHandler(async (req, res) => {
    // Only allow in development environment
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ message: "This endpoint is disabled in production" });
    }

    // Require admin secret (timing-safe)
    if (!verifyAdminSecret(req, res)) return;

    try {
      await stripeService.initializeDefaultTiers();
      res.json({ success: true, message: "Subscription tiers initialized" });
    } catch (error) {
      console.error("Error initializing subscription tiers:", error);
      res.status(500).json({ message: "Failed to initialize subscription tiers" });
    }
  }));

  // Trigger external jobs scraping (for Vercel Cron or manual requests)
  // Returns immediately and scrapes in background (non-blocking)
  app.post('/api/cron/scrape-external-jobs', asyncHandler(async (req, res) => {
    try {
      // Verify cron secret (timing-safe)
      if (!verifyCronSecret(req, res)) return;

      // Return immediately without waiting for scraping to complete
      // This prevents Vercel timeout while still allowing the scraping to happen
      res.json({ message: "External jobs scraping triggered", status: "in_progress" });

      // Trigger scraping in background (fire and forget)
      externalJobsScheduler.triggerScrape()
        .then(result => {
          console.log('[Routes] External jobs scrape completed:', result);
        })
        .catch(error => {
          console.error('[Routes] External jobs scrape failed:', error?.message);
        });
    } catch (error: any) {
      console.error("Error triggering external jobs scrape:", error?.message);
      res.status(500).json({ message: "Failed to trigger external jobs scraping", error: error?.message });
    }
  }));

  // 24h Response SLA enforcement — called hourly by GitHub Actions cron
  // Finds applications where candidate passed exam but recruiter hasn't acted
  // within 24h, marks them as rejected, and notifies the candidate.
  app.post('/api/cron/enforce-response-sla', asyncHandler(async (req, res) => {
    try {
      if (!verifyCronSecret(req, res)) return;

      const overdue = await storage.getOverdueExamApplications();
      if (overdue.length === 0) {
        return res.json({ message: 'No overdue applications', closed: 0 });
      }

      let closed = 0;
      for (const { applicationId, candidateId, jobTitle, company } of overdue) {
        try {
          // Mark as rejected with a system note — not a human rejection
          await storage.updateApplicationStatusByCandidate(applicationId, 'rejected');
          // Notify candidate: transparent, not a ghosting
          await notificationService.createNotification({
            userId: candidateId,
            type: 'application_rejected',
            title: 'Application Closed — No Response',
            message: `${company} did not respond to your ${jobTitle} application within 24 hours. The application has been automatically closed.`,
            priority: 'high',
            relatedApplicationId: applicationId,
            data: { jobTitle, company, reason: 'sla_expired' },
          });
          closed++;
        } catch (err) {
          console.error(`[SLA] Failed to close application ${applicationId}:`, (err as Error).message);
        }
      }

      console.log(`[SLA] Closed ${closed}/${overdue.length} overdue applications`);
      res.json({ message: 'SLA enforcement complete', closed, total: overdue.length });
    } catch (error: any) {
      console.error('[SLA] Enforcement failed:', error?.message);
      res.status(500).json({ message: 'SLA enforcement failed', error: error?.message });
    }
  }));

  // Auto-hide stale internal jobs — called daily by GitHub Actions cron
  // Closes platform jobs with no applicant activity in 14 days, after being
  // active for 30+ days. Prevents ghost jobs from accumulating in the feed.
  app.post('/api/cron/auto-hide-ghost-jobs', asyncHandler(async (req, res) => {
    try {
      if (!verifyCronSecret(req, res)) return;

      const staleDays = Math.max(7, Math.min(365, parseInt((req.query.staleDays as string) || '30', 10) || 30));
      const staleJobs = await storage.getStaleInternalJobs(staleDays);

      if (staleJobs.length === 0) {
        return res.json({ message: 'No stale jobs found', closed: 0 });
      }

      const ids = staleJobs.map((j: any) => j.id);
      const closed = await storage.closeJobsByIds(ids);

      console.log(`[Ghost Auto-Hide] Closed ${closed} stale jobs:`, staleJobs.map((j: any) => `${j.title} @ ${j.company} (id:${j.id})`).join(', '));
      res.json({
        message: 'Ghost job auto-hide complete',
        closed,
        jobs: staleJobs.map((j: any) => ({ id: j.id, title: j.title, company: j.company })),
      });
    } catch (error: any) {
      console.error('[Ghost Auto-Hide] Failed:', error?.message);
      res.status(500).json({ message: 'Ghost job auto-hide failed', error: error?.message });
    }
  }));

  // Purge old external jobs — called daily by GitHub Actions cron
  // Deletes external jobs older than 90 days to prevent unbounded table growth.
  // Internal/platform jobs are never purged (recruiters own them).
  app.post('/api/cron/purge-old-jobs', asyncHandler(async (req, res) => {
    if (!db) return res.status(503).json({ message: 'Database not available' });
    try {
      if (!verifyCronSecret(req, res)) return;

      const retainDays = Math.max(30, Math.min(365, parseInt((req.query.retainDays as string) || '90', 10) || 90));

      // First, find old external jobs eligible for purge
      const candidates = await db.execute(sql`
        SELECT jp.id FROM job_postings jp
        WHERE (jp.source != 'platform' OR jp.source IS NULL)
          AND jp.external_url IS NOT NULL
          AND jp.created_at < NOW() - (${retainDays} || ' days')::interval
      `);
      const candidateIds = ((candidates as any).rows ?? (candidates as any)).map((r: any) => r.id);

      if (candidateIds.length === 0) {
        return res.json({ message: 'No jobs to purge', deleted: 0, retainDays });
      }

      // Delete dependent rows first, then the job postings
      for (const table of ['job_applications', 'job_matches', 'exam_attempts', 'job_exams', 'chat_rooms', 'notifications', 'interviews', 'saved_jobs', 'hidden_jobs']) {
        const col = table === 'notifications' ? 'related_job_id' : 'job_id';
        await db.execute(sql.raw(`DELETE FROM ${table} WHERE ${col} IN (${candidateIds.join(',')})`));
      }
      const result = await db.execute(sql.raw(`DELETE FROM job_postings WHERE id IN (${candidateIds.join(',')}) RETURNING id`));
      const deleted = ((result as any).rows ?? (result as any)).length;
      console.log(`[Purge] Deleted ${deleted} external jobs older than ${retainDays} days`);
      res.json({ message: 'Purge complete', deleted, retainDays });
    } catch (error: any) {
      console.error('[Purge] Failed:', error?.message);
      res.status(500).json({ message: 'Purge failed', error: error?.message });
    }
  }));

  // Discover new companies + ATS probe (two-phase, called by GitHub Actions)
  app.post('/api/cron/discover-companies', asyncHandler(async (req, res) => {
    if (!db) return res.status(503).json({ message: 'Database not available' });
    try {
      if (!verifyCronSecret(req, res)) return;

      const phase = (req.query.phase as string) || 'discover';
      const limit = Math.min(parseInt((req.query.limit as string) || '300', 10), 300);

      if (phase === 'discover') {
        // Phase 1: mine job postings for new company names → save to discovered_companies
        const { companyDiscoveryPipeline } = await import('./company-discovery.js');
        await companyDiscoveryPipeline.runDiscovery();
        const stats = await companyDiscoveryPipeline.getStatistics();
        return res.json({ phase: 'discover', ...stats });
      }

      if (phase === 'probe') {
        // Phase 2: probe pending companies against Greenhouse/Lever/Ashby APIs
        const { probePendingCompanies } = await import('./lib/ats-probe.js');
        const { discoveredCompanies: dcTable } = await import('../shared/schema.js');
        const results = await probePendingCompanies(limit);

        let approved = 0;
        let rejected = 0;
        for (const result of results) {
          if (result.atsType && result.atsId) {
            await db.update(dcTable)
              .set({
                detectedAts: result.atsType,
                atsId: result.atsId,
                careerPageUrl: result.careerPageUrl ?? undefined,
                status: 'approved',
                updatedAt: new Date(),
              })
              .where(eq(dcTable.normalizedName, result.normalizedName));
            approved++;
          } else {
            await db.update(dcTable)
              .set({ status: 'rejected', updatedAt: new Date() })
              .where(eq(dcTable.normalizedName, result.normalizedName));
            rejected++;
          }
        }

        console.log(`[DiscoverCompanies] Probe done: ${approved} approved, ${rejected} rejected`);
        return res.json({ phase: 'probe', probed: results.length, approved, rejected });
      }

      if (phase === 'apollo') {
        // Phase 3: seed companies from Apollo.io (broad industry coverage)
        const { runApolloDiscovery } = await import('./services/apollo-discovery.service.js');
        const apolloResult = await runApolloDiscovery(300);
        return res.json({ phase: 'apollo', ...apolloResult });
      }

      return res.status(400).json({ message: 'Invalid phase. Use ?phase=discover, ?phase=probe, or ?phase=apollo' });
    } catch (error: any) {
      console.error('[DiscoverCompanies] Failed:', error?.message);
      res.status(500).json({ message: 'Company discovery failed', error: error?.message });
    }
  }));

  // Retry failed resume parses — called daily by GitHub Actions
  app.post('/api/cron/retry-failed-parses', asyncHandler(async (req, res) => {
    if (!verifyCronSecret(req, res)) return;
    try {
      // Process 3 per run — Gemini multimodal PDFs are large; spreading over days avoids quota limits
      const candidates = await storage.getCandidatesForParseRetry(3);
      if (candidates.length === 0) {
        return res.json({ retried: 0, succeeded: 0, message: 'No failed parses to retry' });
      }
      const { ResumeService } = await import('./services/resume.service.js');
      const { AIResumeParser } = await import('./ai-resume-parser.js');
      const resumeService = new ResumeService(storage, new AIResumeParser());

      let succeeded = 0;
      const results: Array<{ userId: string; success: boolean; skills: number }> = [];
      for (const candidate of candidates) {
        const result = await resumeService.retryFailedParse(candidate.userId, candidate.resumeUrl!);
        results.push(result);
        if (result.success) succeeded++;
        // 4s delay between candidates — Gemini PDF multimodal is token-heavy
        if (candidates.indexOf(candidate) < candidates.length - 1) {
          await new Promise(r => setTimeout(r, 4000));
        }
      }
      console.log(`[RetryParse] Retried ${candidates.length}, succeeded: ${succeeded}`);
      res.json({ retried: candidates.length, succeeded, results });
    } catch (error: any) {
      console.error('[RetryParse] Failed:', error?.message);
      res.status(500).json({ message: 'Retry failed', error: error?.message });
    }
  }));

  // Warm match cache for all active candidates — called daily by GitHub Actions
  app.post('/api/cron/warm-candidate-matches', asyncHandler(async (req, res) => {
    if (!verifyCronSecret(req, res)) return;
    try {
      const allCandidates = await storage.getAllCandidateUsers();
      const withSkills = allCandidates.filter((c: any) => Array.isArray(c.skills) && c.skills.length > 0);

      res.json({ warming: withSkills.length, message: 'Match warming started in background' });

      // Warm in background — fire and forget
      (async () => {
        let warmed = 0;
        for (const candidate of withSkills) {
          try {
            await storage.getJobRecommendations(candidate.userId);
            warmed++;
            await new Promise(r => setTimeout(r, 100));
          } catch (e: any) {
            console.warn(`[WarmMatches] Failed for ${candidate.userId}:`, e?.message);
          }
        }
        console.log(`[WarmMatches] Warmed ${warmed}/${withSkills.length} candidates`);
      })().catch((e: any) => console.error('[WarmMatches] Background error:', e?.message));
    } catch (error: any) {
      console.error('[WarmMatches] Failed:', error?.message);
      res.status(500).json({ message: 'Warming failed', error: error?.message });
    }
  }));

  // Ghost job detection endpoints
  app.post('/api/admin/run-ghost-job-detection', asyncHandler(async (req, res) => {
    try {
      // Verify admin secret (timing-safe)
      if (!verifyAdminSecret(req, res)) return;

      const { ghostJobDetectionService } = await import('./ghost-job-detection.service');
      
      // Run in background
      res.json({ message: "Ghost job detection started", status: "in_progress" });
      
      ghostJobDetectionService.runBatchAnalysis()
        .then(stats => {
          console.log('[Routes] Ghost job detection completed:', stats);
        })
        .catch(error => {
          console.error('[Routes] Ghost job detection failed:', error?.message);
        });
    } catch (error: any) {
      console.error("Error running ghost job detection:", error?.message);
      res.status(500).json({ message: "Failed to run ghost job detection", error: error?.message });
    }
  }));

  app.get('/api/admin/ghost-job-stats', asyncHandler(async (req, res) => {
    try {
      // Verify admin secret (timing-safe)
      if (!verifyAdminSecret(req, res)) return;

      const { ghostJobDetectionService } = await import('./ghost-job-detection.service');
      const stats = await ghostJobDetectionService.getStatistics();
      const flaggedJobs = await ghostJobDetectionService.getFlaggedJobs(50);

      // Map to match admin UI field names
      res.json({
        totalChecked: stats.totalJobs,
        ghostsFound: stats.flaggedJobs,
        deactivated: stats.criticalRiskJobs,
        lastRun: stats.lastRun || null,
        flaggedJobs,
      });
    } catch (error: any) {
      console.error("Error fetching ghost job stats:", error?.message);
      res.status(500).json({ message: "Failed to fetch ghost job stats", error: error?.message });
    }
  }));

  // Company verification endpoints
  app.post('/api/admin/run-company-verification', asyncHandler(async (req, res) => {
    try {
      // Verify admin secret (timing-safe)
      if (!verifyAdminSecret(req, res)) return;

      const { companyVerificationService } = await import('./company-verification.service');
      
      // Run in background
      res.json({ message: "Company verification started", status: "in_progress" });
      
      companyVerificationService.runBatchVerification()
        .then(stats => {
          console.log('[Routes] Company verification completed:', stats);
        })
        .catch(error => {
          console.error('[Routes] Company verification failed:', error?.message);
        });
    } catch (error: any) {
      console.error("Error running company verification:", error?.message);
      res.status(500).json({ message: "Failed to run company verification", error: error?.message });
    }
  }));

  app.get('/api/admin/company-verification-stats', asyncHandler(async (req, res) => {
    try {
      // Verify admin secret (timing-safe)
      if (!verifyAdminSecret(req, res)) return;

      const { companyVerificationService } = await import('./company-verification.service');
      const stats = await companyVerificationService.getStatistics();

      // Map to match admin UI field names
      res.json({
        totalCompanies: stats.totalJobs,
        verified: stats.verifiedJobs,
        unverified: stats.thirdPartyJobs,
        lastRun: stats.lastRun || null,
      });
    } catch (error: any) {
      console.error("Error fetching company verification stats:", error?.message);
      res.status(500).json({ message: "Failed to fetch company verification stats", error: error?.message });
    }
  }));

  // ── Error Monitoring Admin Endpoints ─────────────────────────────────────────

  // Recent errors — grouped by fingerprint, newest first
  app.get('/api/admin/errors', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) return;
    if (!db) return res.status(503).json({ message: 'Database not available' });
    const { errorEvents } = await import('../shared/schema.js');
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10) || 50, 200);
    const level = req.query.level as string; // optional filter: error, warning, fatal

    const errors = level
      ? await db.select().from(errorEvents).where(eq(errorEvents.level, level)).orderBy(sql`created_at DESC`).limit(limit)
      : await db.select().from(errorEvents).orderBy(sql`created_at DESC`).limit(limit);

    // Also get grouped counts (top errors by fingerprint in last 24h)
    const grouped = await db.execute(sql`
      SELECT fingerprint, message, component, level, COUNT(*)::int as count,
             MAX(created_at) as last_seen
      FROM error_events
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY fingerprint, message, component, level
      ORDER BY count DESC
      LIMIT 20
    `);

    res.json({
      errors,
      grouped: (grouped as any).rows ?? grouped,
      total: errors.length,
    });
  }));

  // Cleanup old errors (keep last 30 days) — called by cron or manually
  app.post('/api/cron/cleanup-errors', asyncHandler(async (req, res) => {
    if (!verifyCronSecret(req, res)) return;
    if (!db) return res.status(503).json({ message: 'Database not available' });
    const result = await db.execute(sql`
      DELETE FROM error_events WHERE created_at < NOW() - INTERVAL '30 days' RETURNING id
    `);
    const deleted = ((result as any).rows ?? (result as any)).length;
    console.log(`[ErrorCleanup] Deleted ${deleted} error events older than 30 days`);
    res.json({ deleted });
  }));

  // ── Invite Code Admin Endpoints ──────────────────────────────────────────────

  // Create invite codes (single or batch)
  app.post('/api/admin/invite-codes', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) return;
    const { code, description, role, maxUses, count, prefix, expiresAt } = req.body;

    // Batch mode: generate `count` codes with a prefix
    if (count && count > 0) {
      const codes = [];
      const batchSize = Math.min(count, 100);
      for (let i = 0; i < batchSize; i++) {
        const generated = (prefix || 'REC') + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const created = await storage.createInviteCode({
          code: generated,
          description: description || `Batch ${new Date().toISOString().split('T')[0]}`,
          role: role || 'any',
          maxUses: maxUses ?? 1,
          createdBy: 'admin',
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        });
        codes.push(created);
      }
      return res.json({ created: codes.length, codes: codes.map((c: any) => c.code) });
    }

    // Single code mode
    if (!code) return res.status(400).json({ message: 'Code or count required' });
    const created = await storage.createInviteCode({
      code,
      description,
      role: role || 'any',
      maxUses: maxUses ?? 1,
      createdBy: 'admin',
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });
    res.json(created);
  }));

  // List all invite codes with usage stats
  app.get('/api/admin/invite-codes', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) return;
    const codes = await storage.listInviteCodes();
    res.json(codes);
  }));

  // Signup source breakdown (for GTM channel tracking)
  app.get('/api/admin/signup-sources', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) return;
    const result = await db.execute(sql`
      SELECT signup_source, COUNT(*) as count,
             MIN("createdAt") as first_signup, MAX("createdAt") as last_signup
      FROM users
      WHERE signup_source IS NOT NULL
      GROUP BY signup_source
      ORDER BY count DESC
    `);
    res.json((result as any).rows ?? result);
  }));

  // Embedding stats for debugging matching issues
  app.get('/api/admin/embedding-stats', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) return;
    const result = await db.execute(sql`
      SELECT 'job_postings' AS table_name, COUNT(*) AS total, COUNT(embedding) AS with_embedding FROM job_postings
      UNION ALL
      SELECT 'candidate_users', COUNT(*), COUNT(embedding) FROM candidate_users
    `);
    res.json((result as any).rows ?? result);
  }));

  // Check/create HNSW index
  app.get('/api/admin/embedding-index', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) return;
    try {
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_job_embedding_hnsw ON job_postings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`);
      res.json({ success: true, message: 'HNSW index created/verified' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));

  // Pipeline (cron) health: last run status/age per scheduled ingestion + embedding job.
  app.get('/api/admin/pipeline-health', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) return;
    const { getPipelineHealth } = await import('./services/pipeline-run.service');
    res.json(await getPipelineHealth());
  }));

  // ── End Invite Code Endpoints ──────────────────────────────────────────────

  // ── Feedback Loop / Weight Tuning Endpoints ─────────────────────────────────

  // Correlation stats: how well do current match scores predict exam outcomes?
  app.get('/api/admin/feedback-loop/stats', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) return;
    const { getCorrelationStats } = await import('./services/match-signals.service');
    const stats = await getCorrelationStats();
    res.json(stats);
  }));

  // Trigger weight tuning: learn optimal weights from labeled exam data
  app.post('/api/admin/feedback-loop/tune', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) return;
    const { tuneWeights } = await import('./services/match-signals.service');
    const result = await tuneWeights();
    res.json(result);
  }));

  // Get current learned weights (or null if no tuning has happened)
  app.get('/api/admin/feedback-loop/weights', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) return;
    const { getLearnedWeights } = await import('./services/match-signals.service');
    const weights = await getLearnedWeights();
    res.json({ weights, isDefault: weights === null });
  }));

  // ── End Feedback Loop Endpoints ─────────────────────────────────────────────

  // Job quality indicators for candidates
  app.get('/api/jobs/:jobId/quality-indicators', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const jobId = parseInt(req.params.jobId);
      if (isNaN(jobId)) {
        return res.status(400).json({ message: "Invalid job ID" });
      }

      const job = await storage.getJobPosting(jobId);
      if (!job) {
        return res.status(404).json({ message: "Job not found" });
      }

      // Return quality indicators without exposing sensitive data
      res.json({
        trustScore: job.trustScore || 50,
        livenessStatus: job.livenessStatus || 'unknown',
        ghostJobScore: job.ghostJobScore || 0,
        ghostJobStatus: job.ghostJobStatus || 'clean',
        companyVerified: job.companyVerified || false,
        viewCount: job.viewCount || 0,
        applicationCount: job.applicationCount || 0,
        isExternal: job.source !== 'platform',
      });
    } catch (error: any) {
      console.error("Error fetching job quality indicators:", error?.message);
      res.status(500).json({ message: "Failed to fetch job quality indicators", error: error?.message });
    }
  }));

  app.get('/api/candidate/notification-preferences', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const prefs = await storage.getNotificationPreferences(req.user.id);
      res.json(prefs || {});
    } catch (error) {
      console.error("Error fetching notification preferences:", error);
      res.status(500).json({ message: "Failed to fetch preferences" });
    }
  }));

  app.put('/api/candidate/notification-preferences', isAuthenticated, asyncHandler(async (req: any, res) => {
    try {
      const prefs = await storage.updateNotificationPreferences(req.user.id, req.body);
      res.json(prefs);
    } catch (error) {
      console.error("Error updating notification preferences:", error);
      res.status(500).json({ message: "Failed to update preferences" });
    }
  }));

  // User feedback / bug reports — emails Abas directly
  // Rate-limited to prevent spam; sanitized to prevent email HTML injection.
  app.post('/api/feedback', rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }), asyncHandler(async (req: any, res) => {
    const { type, message, userEmail, userName } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }
    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const validTypes = ['Bug', 'Suggestion', 'Other'];
    const feedbackType = validTypes.includes(type) ? type : 'Other';
    const safeEmail = typeof userEmail === 'string' ? escHtml(userEmail.slice(0, 200)) : '';
    const safeName = typeof userName === 'string' ? escHtml(userName.slice(0, 100)) : '';
    const safeMessage = escHtml(String(message).slice(0, 5000));
    const from = safeEmail ? `${safeName || safeEmail} <${safeEmail}>` : 'Anonymous';
    await sendEmail({
      to: 'support@recrutas.ai',
      from: 'noreply@recrutas.ai',
      subject: `[Recrutas Feedback] ${feedbackType} — ${safeEmail || 'anonymous'}`,
      html: `
        <p><strong>Type:</strong> ${feedbackType}</p>
        <p><strong>From:</strong> ${from}</p>
        <hr/>
        <p>${safeMessage.replace(/\n/g, '<br/>')}</p>
      `,
    });
    res.json({ ok: true });
  }));

  // ── Waitlist: early access signup ──────────────────────────────────────────
  app.post('/api/waitlist', rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }), asyncHandler(async (req: any, res) => {
    const { email, firstName, lastName, source } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    const normalizedEmail = email.trim().toLowerCase().slice(0, 255);

    // Check if already on waitlist
    const existing = await db.select().from(waitlistEntries).where(eq(waitlistEntries.email, normalizedEmail)).limit(1);
    if (existing.length > 0) {
      return res.json({ ok: true, message: "You're already on the list! We'll reach out soon." });
    }

    await db.insert(waitlistEntries).values({
      email: normalizedEmail,
      firstName: typeof firstName === 'string' ? firstName.trim().slice(0, 100) : null,
      lastName: typeof lastName === 'string' ? lastName.trim().slice(0, 100) : null,
      source: typeof source === 'string' ? source.trim().slice(0, 50) : 'early-access-page',
    });

    // Send confirmation email
    await sendEmail({
      to: normalizedEmail,
      from: 'noreply@recrutas.ai',
      subject: "You're on the Recrutas early access list!",
      html: `
        <p>Hey${firstName ? ` ${firstName.trim()}` : ''},</p>
        <p>Thanks for signing up for early access to <strong>Recrutas</strong>.</p>
        <p>We're letting people in on a rolling basis. You'll get an invite code in your inbox as soon as a spot opens up.</p>
        <p>— The Recrutas Team</p>
      `,
    }).catch((err: Error) => console.error('[Waitlist] Failed to send confirmation email:', err));

    // Notify admin
    await sendEmail({
      to: 'hello@recrutas.ai',
      from: 'noreply@recrutas.ai',
      subject: `[Waitlist] New signup: ${normalizedEmail}`,
      html: `<p><strong>${firstName || ''} ${lastName || ''}</strong> (${normalizedEmail}) joined the waitlist.</p><p>Source: ${source || 'early-access-page'}</p>`,
    }).catch((err: Error) => console.error('[Waitlist] Failed to send admin notification:', err));

    res.json({ ok: true, message: "You're in! Check your email for confirmation." });
  }));

  // Inngest serve endpoint — receives events from Inngest Cloud
  // Required for background functions (match/recompute, sla/enforce, candidate/notify)
  if (process.env.INNGEST_EVENT_KEY) {
    const { serve } = await import('inngest/express');
    const { inngest, inngestFunctions } = await import('./inngest-service.js');
    app.use('/api/inngest', serve({ client: inngest, functions: inngestFunctions }));
    console.log('[Inngest] Serve endpoint registered at /api/inngest');
  }

  return app;
}