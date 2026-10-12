# Implementation Prompt for Gemini

## Context

You are implementing fixes for a recruiting platform built with:
- **Backend**: Node.js/Express, TypeScript
- **Frontend**: React, TypeScript
- **Database**: PostgreSQL via Drizzle ORM
- **Current Working Directory**: `/home/abaskabato/recrutas`

## Your Task

Fix two critical issues preventing the platform from functioning:

### Issue 1: Resume Upload Returns 500 Error
The resume upload endpoint returns 500 with "unable to fetch profile" because the backend returns a raw profile object instead of the structured `ResumeProcessingResult` that the frontend expects.

### Issue 2: Job Engine Not Working End-to-End
External jobs are scraped but never stored in the database. Trust scores exist but aren't used in matching. No background refresh scheduler. This breaks the entire job recommendation pipeline.

---

## ISSUE 1: FIX RESUME UPLOAD (Priority: CRITICAL - Do First)

### Problem Details

**File**: `server/services/resume.service.ts`
- **Lines 201-208**: The `uploadAndProcessResume()` method currently returns:
  ```typescript
  const updatedProfile = await this.storage.getCandidateUser(userId);
  return updatedProfile;
  ```
- **Problem**: Frontend expects `ResumeProcessingResult` structure with fields:
  - `resumeUrl: string`
  - `parsed: boolean`
  - `aiParsing: { success, confidence, processingTime }`
  - `extractedInfo: { skillsCount, experience, workHistoryCount, ... }`
  - `autoMatchingTriggered: boolean`

### Implementation Steps

#### Step 1.1: Update Resume Service Return Type

**File**: `server/services/resume.service.ts`

**Line 46-50** - Change return type:
```typescript
async uploadAndProcessResume(
  userId: string,
  fileBuffer: Buffer,
  mimetype: string
): Promise<ResumeProcessingResult> {  // Changed from Promise<any>
```

**Lines 201-208** - Replace the return statement with structured result:

```typescript
// After updating, fetch the complete profile to return to the client
try {
  const updatedProfile = await this.storage.getCandidateUser(userId);

  // Transform profile into expected ResumeProcessingResult structure
  const result: ResumeProcessingResult = {
    resumeUrl: updatedProfile.resumeUrl || resumeUrl,
    parsed: parsingSuccess,
    aiParsing: {
      success: parsingSuccess,
      confidence: parsedData?.confidence || 0,
      processingTime: parsedData?.processingTime || 0,
    },
    extractedInfo: parsingSuccess && aiExtracted ? {
      skillsCount: aiExtracted.skills?.technical?.length || 0,
      softSkillsCount: aiExtracted.skills?.soft?.length || 0,
      experience: aiExtracted.experience?.level || 'entry',
      workHistoryCount: aiExtracted.experience?.positions?.length || 0,
      educationCount: aiExtracted.education?.length || 0,
      certificationsCount: aiExtracted.certifications?.length || 0,
      projectsCount: aiExtracted.projects?.length || 0,
      hasContactInfo: !!(aiExtracted.personalInfo?.email || aiExtracted.personalInfo?.phone),
      extractedName: aiExtracted.personalInfo?.name || '',
      extractedLocation: aiExtracted.personalInfo?.location || '',
      linkedinFound: !!aiExtracted.personalInfo?.linkedin,
      githubFound: !!aiExtracted.personalInfo?.github,
    } : null,
    autoMatchingTriggered: false,
  };

  return result;
} catch (error) {
  console.error('ResumeService: Error fetching updated profile after upsert:', error);
  // Return partial success result with what we have
  return {
    resumeUrl: resumeUrl,
    parsed: parsingSuccess,
    aiParsing: {
      success: parsingSuccess,
      confidence: parsedData?.confidence || 0,
      processingTime: parsedData?.processingTime || 0,
    },
    extractedInfo: null,
    autoMatchingTriggered: false,
  };
}
```

**Lines 77-83** - Improve error handling:
```typescript
let existingProfile;
try {
  existingProfile = await this.storage.getCandidateUser(userId);
} catch (error) {
  console.error('ResumeService: Error fetching existing candidate profile:', error);
  existingProfile = null; // Don't throw - we can proceed with null
}
```

#### Step 1.2: Update Test Assertions

**File**: `test/resume-upload-fix.test.js`

**Lines 111-122** - Update to validate structure:
```javascript
// Validate the response structure matches ResumeProcessingResult
if (typeof response.body.parsed !== 'boolean') {
  throw new Error('Response body missing "parsed" boolean field.');
}
if (!response.body.aiParsing || typeof response.body.aiParsing.success !== 'boolean') {
  throw new Error('Response body missing "aiParsing" object with success field.');
}
if (!response.body.resumeUrl) {
  throw new Error('Response body missing "resumeUrl" field.');
}

console.log('✅ Test Passed. Resume upload returns correct ResumeProcessingResult structure.');
```

#### Step 1.3: Test Resume Upload

Run the test:
```bash
npm run test
```

Expected output: Test passes with validation that `ResumeProcessingResult` structure is returned.

---

## ISSUE 2: FIX JOB ENGINE END-TO-END (Priority: HIGH - Do After Resume Fix)

### Phase 2A: Create Job Ingestion Service

#### Step 2A.1: Create New Job Ingestion Service File

**Create File**: `server/services/job-ingestion.service.ts`

```typescript
/**
 * Job Ingestion Service
 * Persists external jobs to database with deduplication
 */

import { db } from '../db';
import { jobPostings } from '@shared/schema';
import { eq, and, sql } from 'drizzle-orm';

export interface ExternalJobInput {
  title: string;
  company: string;
  location: string;
  description: string;
  requirements: string[];
  skills: string[];
  workType: 'remote' | 'hybrid' | 'onsite';
  salaryMin?: number;
  salaryMax?: number;
  source: string;
  externalId: string;
  externalUrl: string;
  postedDate: string;
}

function getSourceTrustScore(source: string): number {
  const trustScores: Record<string, number> = {
    'greenhouse': 95,
    'lever': 95,
    'workday': 90,
    'company-api': 95,
    'jsearch': 70,
    'remoteok': 75,
    'themuse': 70,
    'arbeitnow': 65,
    'usajobs': 85,
    'default': 50
  };
  return trustScores[source.toLowerCase()] || trustScores.default;
}

export class JobIngestionService {
  async ingestExternalJobs(jobs: ExternalJobInput[]): Promise<{ inserted: number; duplicates: number; errors: number }> {
    const stats = { inserted: 0, duplicates: 0, errors: 0 };

    console.log(`[JobIngestion] Processing ${jobs.length} external jobs...`);

    for (const job of jobs) {
      try {
        // Check if job already exists (by externalId + source)
        const existing = await db
          .select()
          .from(jobPostings)
          .where(
            and(
              eq(jobPostings.externalId, job.externalId),
              eq(jobPostings.source, job.source)
            )
          )
          .limit(1);

        if (existing.length > 0) {
          stats.duplicates++;
          // Update liveness for existing jobs
          await db
            .update(jobPostings)
            .set({
              lastLivenessCheck: new Date(),
              livenessStatus: 'active',
              updatedAt: new Date()
            })
            .where(eq(jobPostings.id, existing[0].id));
          continue;
        }

        // Calculate trust score and expiration
        const trustScore = getSourceTrustScore(job.source);
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 60);

        // Insert new external job
        await db.insert(jobPostings).values({
          talentOwnerId: 'system',
          title: job.title,
          company: job.company,
          location: job.location,
          description: job.description,
          requirements: job.requirements,
          skills: job.skills,
          workType: job.workType,
          salaryMin: job.salaryMin,
          salaryMax: job.salaryMax,
          source: job.source,
          externalId: job.externalId,
          externalUrl: job.externalUrl,
          trustScore: trustScore,
          livenessStatus: 'unknown',
          lastLivenessCheck: new Date(),
          expiresAt: expiresAt,
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        stats.inserted++;
      } catch (error) {
        console.error(`[JobIngestion] Error ingesting job ${job.title}:`, error);
        stats.errors++;
      }
    }

    console.log(`[JobIngestion] Complete. Inserted: ${stats.inserted}, Duplicates: ${stats.duplicates}, Errors: ${stats.errors}`);
    return stats;
  }

  async expireStaleJobs(): Promise<number> {
    const result = await db
      .update(jobPostings)
      .set({
        status: 'closed',
        livenessStatus: 'stale'
      })
      .where(
        and(
          sql`${jobPostings.source} != 'platform'`,
          sql`${jobPostings.expiresAt} < NOW()`,
          eq(jobPostings.status, 'active')
        )
      );

    return result.rowCount || 0;
  }
}

export const jobIngestionService = new JobIngestionService();
```

### Phase 2B: Update Job Recommendations to Use Trust Scores

#### Step 2B.1: Update Storage Service

**File**: `server/storage.ts`

**Lines 520-603** - Replace the `getJobRecommendations()` method with this version:

```typescript
async getJobRecommendations(candidateId: string): Promise<any[]> {
  try {
    const candidate = await this.getCandidateUser(candidateId);
    if (!candidate || !candidate.skills || candidate.skills.length === 0) {
      return [];
    }

    // Fetch active, non-expired, non-stale jobs (internal + external)
    const allJobs = await db
      .select()
      .from(jobPostings)
      .where(and(
        eq(jobPostings.status, 'active'),
        or(...candidate.skills.map(skill =>
          sql`${jobPostings.skills} @> jsonb_build_array(${skill}::text)`
        )),
        or(
          sql`${jobPostings.expiresAt} IS NULL`,
          sql`${jobPostings.expiresAt} > NOW()`
        ),
        // Filter out stale jobs
        or(
          eq(jobPostings.livenessStatus, 'active'),
          eq(jobPostings.livenessStatus, 'unknown')
        )
      ))
      .orderBy(
        sql`${jobPostings.trustScore} DESC NULLS LAST`,
        sql`${jobPostings.createdAt} DESC`
      )
      .limit(100);

    const jobsWithSource = allJobs.map((job: any) => ({
      ...job,
      requirements: Array.isArray(job.requirements) ? job.requirements : [],
      skills: Array.isArray(job.skills) ? job.skills : []
    }));

    console.log(`Found ${jobsWithSource.length} matching jobs (internal + external)`);

    // Generate AI-powered recommendations
    const { generateJobMatch } = await import("./ai-service");
    const recommendations = [];

    for (const job of jobsWithSource) {
      const match = await generateJobMatch(candidate, job as any);
      if (match.score > 0.4) {
        recommendations.push({
          ...job,
          matchScore: Math.round(match.score * 100),
          aiExplanation: match.aiExplanation,
          skillMatches: match.skillMatches,
          isVerifiedActive: job.livenessStatus === 'active' && job.trustScore >= 90,
          isDirectFromCompany: job.trustScore >= 85,
        });
      }
    }

    // Sort by combined score: match score * (trust score / 100)
    recommendations.sort((a, b) => {
      const scoreA = a.matchScore * ((a.trustScore || 50) / 100);
      const scoreB = b.matchScore * ((b.trustScore || 50) / 100);
      return scoreB - scoreA;
    });

    return recommendations.slice(0, 20);
  } catch (error) {
    console.error('Error fetching job recommendations:', error);
    throw error;
  }
}
```

### Phase 2C: Update External Jobs Route

#### Step 2C.1: Update Route to Persist Jobs

**File**: `server/routes.ts`

**Lines 276-285** - Replace the `/api/external-jobs` route:

```typescript
// Universal job scraper with database persistence
app.get('/api/external-jobs', async (req, res) => {
  try {
    const skills = req.query.skills ? (req.query.skills as string).split(',') : [];
    const jobs = await jobAggregator.getAllJobs(skills);

    // Persist jobs to database
    const { jobIngestionService } = await import('./services/job-ingestion.service');
    const stats = await jobIngestionService.ingestExternalJobs(jobs);

    res.json({
      jobs,
      ingestionStats: stats
    });
  } catch (error) {
    console.error('Error scraping external jobs:', error);
    res.status(500).json({ message: 'Failed to scrape external jobs' });
  }
});
```

### Phase 2D: Update Client-Side Matching Algorithm

#### Step 2D.1: Add Trust Score to Matching

**File**: `client/src/lib/matching.ts`

**Find the `calculateJobMatch()` function (around lines 31-96)** and add trust score modifier before the return statement:

```typescript
// Apply trust score modifier (add this before the final return)
if (job.trustScore !== undefined) {
  if (job.trustScore >= 90) {
    score = Math.min(score * 1.05, maxScore);
    reasons.push('verified active position');
  } else if (job.trustScore < 50) {
    score = score * 0.9;
  }
}

return {
  score: Math.min(Math.round(score), maxScore),
  reasons: reasons.slice(0, 3),
};
```

### Phase 2E: Add Database Constraints

#### Step 2E.1: Create Migration File

**Create File**: `drizzle/0002_external_job_dedup.sql`

```sql
-- Add unique constraint on external jobs for deduplication
ALTER TABLE job_postings
  ADD CONSTRAINT job_external_unique
  UNIQUE (external_id, source);

-- Create index for faster liveness filtering
CREATE INDEX IF NOT EXISTS idx_job_liveness
  ON job_postings(liveness_status, expires_at);

-- Create index for trust score sorting
CREATE INDEX IF NOT EXISTS idx_job_trust_score
  ON job_postings(trust_score DESC);
```

#### Step 2E.2: Apply Migration

Run the migration:
```bash
npm run db:push
```

Or manually apply the SQL file:
```bash
psql $DATABASE_URL -f drizzle/0002_external_job_dedup.sql
```

### Phase 2F: Create Background Job Refresh Service

#### Step 2F.1: Create Job Refresh Service

**Create File**: `server/services/job-refresh.service.ts`

```typescript
/**
 * Job Refresh Service
 * Periodically refreshes external jobs from multiple sources
 */

import { jobIngestionService } from './job-ingestion.service';

class JobRefreshService {
  private refreshInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  start(): void {
    if (this.isRunning) {
      console.log('[JobRefresh] Already running');
      return;
    }

    console.log('[JobRefresh] Starting job refresh service...');
    this.isRunning = true;

    // Run initial refresh
    this.runRefresh().catch(console.error);

    // Schedule periodic refresh every 6 hours
    this.refreshInterval = setInterval(() => {
      this.runRefresh().catch(console.error);
    }, 6 * 60 * 60 * 1000);
  }

  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    this.isRunning = false;
    console.log('[JobRefresh] Stopped');
  }

  private async runRefresh(): Promise<void> {
    console.log('[JobRefresh] Starting refresh cycle...');
    const startTime = Date.now();

    try {
      // Scrape from career pages
      let careerPageJobs: any[] = [];
      try {
        const { careerPageScraper } = await import('../career-page-scraper');
        careerPageJobs = await careerPageScraper.getAllJobs(['software', 'engineer', 'developer']);
        console.log(`[JobRefresh] Scraped ${careerPageJobs.length} jobs from career pages`);
      } catch (err) {
        console.error('[JobRefresh] Career page scraping failed:', err);
      }

      // Fetch from job aggregators
      let aggregatorJobs: any[] = [];
      try {
        const { jobAggregator } = await import('../job-aggregator');
        aggregatorJobs = await jobAggregator.getAllJobs(['software', 'engineer', 'developer']);
        console.log(`[JobRefresh] Fetched ${aggregatorJobs.length} jobs from aggregators`);
      } catch (err) {
        console.error('[JobRefresh] Job aggregator failed:', err);
      }

      // Ingest all jobs
      const allJobs = [...careerPageJobs, ...aggregatorJobs];
      const stats = await jobIngestionService.ingestExternalJobs(allJobs);

      // Expire stale jobs
      const expiredCount = await jobIngestionService.expireStaleJobs();

      const duration = Date.now() - startTime;
      console.log(`[JobRefresh] Complete in ${duration}ms. New: ${stats.inserted}, Duplicates: ${stats.duplicates}, Expired: ${expiredCount}`);
    } catch (error) {
      console.error('[JobRefresh] Error during refresh:', error);
    }
  }
}

export const jobRefreshService = new JobRefreshService();
```

#### Step 2F.2: Integrate into Server Startup

**File**: `server/index.ts`

**Find the `initializeBackgroundServices()` function (around lines 42-64)** and add:

```typescript
// Add this inside initializeBackgroundServices() after job liveness service

// Start job refresh service
try {
  const { jobRefreshService } = await import('./services/job-refresh.service.js');
  jobRefreshService.start();
  console.log('[Services] ✓ Job refresh service started');
} catch (e) {
  console.error('[Services] Job refresh service failed to start:', e);
}
```

---

## Testing & Verification

### Test Resume Upload (After Phase 1)

```bash
# Run test suite
npm run test

# Expected output:
# ✅ Test Passed. Resume upload returns correct ResumeProcessingResult structure.
```

### Test Job Engine (After Phase 2)

```bash
# 1. Test external job fetch and persistence
curl http://localhost:5001/api/external-jobs?skills=software,engineer

# Expected response:
# { "jobs": [...], "ingestionStats": { "inserted": X, "duplicates": Y, "errors": 0 } }

# 2. Verify jobs in database
# Run in PostgreSQL:
SELECT COUNT(*), source FROM job_postings WHERE source != 'platform' GROUP BY source;

# Expected: Should show jobs from different sources

# 3. Test deduplication - run same API call twice
curl http://localhost:5001/api/external-jobs?skills=software,engineer

# Expected: Second call shows higher duplicate count, no new inserts

# 4. Check background service logs
# Look for: [Services] ✓ Job refresh service started
# After 6 hours: [JobRefresh] Complete in Xms...

# 5. Test job recommendations with trust scores
curl -H "Authorization: Bearer <token>" http://localhost:5001/api/ai-matches

# Expected: Jobs with high trust scores ranked higher, includes isVerifiedActive badge
```

---

## Success Criteria

**Resume Upload:**
- ✅ Test passes without errors
- ✅ Frontend displays "Extracted X skills and Y work experiences"
- ✅ No 500 errors in server logs for resume uploads

**Job Engine:**
- ✅ External jobs persist to database (verify with SQL query)
- ✅ Duplicate jobs not inserted (check ingestionStats.duplicates)
- ✅ High-trust jobs appear first in recommendations
- ✅ Stale jobs (livenessStatus='stale') filtered out
- ✅ Background refresh service starts on server boot
- ✅ Job feed includes trust indicators (isVerifiedActive, isDirectFromCompany)

---

## Implementation Order

**Do in this exact order:**

1. **Resume Upload Fix** (Phase 1)
   - Update `resume.service.ts` return structure
   - Update test assertions
   - Test end-to-end

2. **Job Persistence** (Phase 2A-2C)
   - Create `job-ingestion.service.ts`
   - Update `storage.ts` recommendations
   - Update `/api/external-jobs` route
   - Apply database migration

3. **Trust Score Integration** (Phase 2D)
   - Update `matching.ts` algorithm

4. **Background Refresh** (Phase 2E-2F)
   - Create `job-refresh.service.ts`
   - Integrate into server startup

---

## Important Notes

- **Line numbers are approximate** - look for the function/code block described
- **Test after each phase** - don't move to next phase if tests fail
- **Database migration required** - run `npm run db:push` or apply SQL manually
- **Import paths** - Use correct import syntax for the project (check existing files for patterns)
- **Error handling** - All try/catch blocks should log errors but not crash the service

---

## Files You Will Create

1. `server/services/job-ingestion.service.ts`
2. `server/services/job-refresh.service.ts`
3. `drizzle/0002_external_job_dedup.sql`

## Files You Will Modify

1. `server/services/resume.service.ts` (lines ~46, ~77, ~201-208)
2. `test/resume-upload-fix.test.js` (lines ~111-122)
3. `server/storage.ts` (lines ~520-603)
4. `server/routes.ts` (lines ~276-285)
5. `client/src/lib/matching.ts` (lines ~31-96)
6. `server/index.ts` (lines ~42-64)

Good luck with the implementation!
