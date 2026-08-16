import { IStorage } from '../storage';
import { AIResumeParser } from '../ai-resume-parser';
import { User } from '@shared/schema';
import { normalizeSkills } from '../skill-normalizer';
import { sendInngestEvent } from '../inngest-service.js';
import { captureException } from '../error-monitoring';
import { invalidateCandidateEmbedding } from './candidate-embedding.service';
import { track } from '../lib/analytics';

/** Recursively strip PostgreSQL-illegal null bytes (\0) from all strings in a value. */
function stripNullBytes<T>(val: T): T {
  if (typeof val === 'string') return val.replace(/\0/g, '') as unknown as T;
  if (Array.isArray(val)) return val.map(stripNullBytes) as unknown as T;
  if (val && typeof val === 'object' && !(val instanceof Date)) {
    for (const k of Object.keys(val)) (val as any)[k] = stripNullBytes((val as any)[k]);
  }
  return val;
}

/**
 * Collapse a provider's raw error text into a small, stable set of causes.
 *
 * These are not interchangeable and the distinction is the whole point:
 * `model_retired` never recovers on its own and needs a human to change a
 * pinned model id, while `quota` and `overloaded` clear by themselves. Treating
 * the first as if it were the second is exactly what hid a dead
 * `gemini-2.0-flash` behind "the free tier must be exhausted again".
 */
/** Total skills across all three buckets — the usual "did we get anything" measure. */
function extractedSkillsCount(aiExtracted: any): number {
  return (aiExtracted?.skills?.technical?.length || 0) +
    (aiExtracted?.skills?.soft?.length || 0) +
    (aiExtracted?.skills?.tools?.length || 0);
}

export function classifyPrimaryError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('404') || m.includes('no longer available') || m.includes('not found')) return 'model_retired';
  if (m.includes('429') || m.includes('quota') || m.includes('rate limit')) return 'quota';
  if (m.includes('503') || m.includes('overloaded') || m.includes('high demand') || m.includes('unavailable')) return 'overloaded';
  if (m.includes('timeout') || m.includes('aborted')) return 'timeout';
  if (m.includes('401') || m.includes('403') || m.includes('api key')) return 'auth';
  return 'other';
}

/**
 * Custom error for resume processing failures
 * @extends Error
 */
export class ResumeProcessingError extends Error {
  constructor(message: string, public originalError?: any) {
    super(message);
    this.name = 'ResumeProcessingError';
    Object.setPrototypeOf(this, ResumeProcessingError.prototype);
  }
}

// Define the result structure for resume processing
/**
 * Result structure for resume processing operations
 * @interface ResumeProcessingResult
 */
export interface ResumeProcessingResult {
  resumeUrl: string;
  parsed: boolean;
  aiParsing: {
    success: boolean;
    confidence: number;
    processingTime: number;
  };
  extractedInfo: {
    // Full extracted data
    skills: {
      technical: string[];
      soft: string[];
      tools: string[];
    };
    experience: {
      level: string;
      years: number;
      positions: Array<{
        title: string;
        company: string;
        duration: string;
        description?: string;
      }>;
    };
    education: Array<{
      institution: string;
      degree: string;
      field?: string;
      year?: string;
    }>;
    certifications: string[];
    projects: Array<{
      name: string;
      description?: string;
      technologies?: string[];
    }>;
    personalInfo: {
      name: string;
      email: string;
      phone: string;
      location: string;
      linkedin: string;
      github: string;
      website: string;
    };
    // Summary counts
    skillsCount: number;
    workHistoryCount: number;
    educationCount: number;
    certificationsCount: number;
    projectsCount: number;
  } | null;
  autoMatchingTriggered: boolean;
}

export class ResumeService {
  constructor(
    private storage: IStorage,
    private aiResumeParser: AIResumeParser
  ) {}

  /**
   * Surface WHICH engine parsed a résumé, and shout when it wasn't the good one.
   *
   * Motivation: `gemini-2.0-flash` was retired by Google and returned 404 on
   * every call. The pipeline dutifully fell through to its fallbacks and kept
   * reporting success, so the outage was invisible until someone read a wrong
   * job title on a profile. A degraded parse is not an error — it is a silently
   * lower-quality result, which is exactly the kind nothing catches.
   *
   * Two channels on purpose: a PostHog event (aggregate — "what fraction of
   * parses are degraded this week") and a `console.error` (per-incident — shows
   * up in Vercel logs with the provider's own reason attached).
   */
  private reportParseProvenance(userId: string, parseResult: any, totalSkills: number) {
    if (!parseResult) return;
    const { extractor, degraded, primaryError, confidence } = parseResult;

    track(userId, 'resume_parsed', {
      extractor,
      degraded: !!degraded,
      confidence: confidence ?? 0,
      total_skills: totalSkills,
      positions: parseResult.aiExtracted?.experience?.positions?.length ?? 0,
      // Bucketed, not raw: the raw string is unbounded provider text and would
      // shred the cardinality of any PostHog breakdown built on it.
      primary_failure: primaryError ? classifyPrimaryError(primaryError) : undefined,
    });

    if (degraded) {
      console.error(
        `[ResumeService] DEGRADED PARSE user=${userId} extractor=${extractor} ` +
        `skills=${totalSkills} — preferred engine unavailable` +
        (primaryError ? `: ${primaryError}` : ''),
      );
    }
  }

  /**
   * Upload and process resume synchronously.
   * Upload always succeeds; AI parsing failures are handled gracefully.
   */
  async uploadAndProcessResume(
    userId: string,
    fileBuffer: Buffer,
    mimetype: string
  ): Promise<ResumeProcessingResult> {
    const startTime = Date.now();
    console.log(`[ResumeService] Starting resume upload for user: ${userId}`);

    let resumeUrl = '';

    try {
      // Set processing status
      await this.storage.upsertCandidateUser({
        userId,
        resumeProcessingStatus: 'processing'
      });

      // Delete old resume file from storage if it exists
      try {
        const existingProfile = await this.storage.getCandidateUser(userId);
        if (existingProfile?.resumeUrl) {
          const oldPath = (existingProfile.resumeUrl as string);
          if (!oldPath.startsWith('http')) {
            const { supabaseAdmin } = await import('../lib/supabase-admin.js');
            await supabaseAdmin.storage.from('resumes').remove([oldPath]);
            console.log(`[ResumeService] Deleted old resume: ${oldPath}`);
          }
        }
      } catch (cleanupErr: any) {
        console.warn('[ResumeService] Old resume cleanup failed (non-fatal):', cleanupErr?.message);
      }

      // Step 1: Upload file to storage (this must succeed)
      console.log(`[ResumeService] Uploading file (${fileBuffer.length} bytes)...`);
      resumeUrl = await this.storage.uploadResume(fileBuffer, mimetype);
      console.log(`[ResumeService] File uploaded to: ${resumeUrl}`);

      // Save resume URL immediately
      await this.storage.upsertCandidateUser({ userId, resumeUrl });

    } catch (uploadError: any) {
      console.error(`[ResumeService] Upload failed for user ${userId}:`, uploadError);
      await this.storage.upsertCandidateUser({
        userId,
        resumeProcessingStatus: 'failed'
      }).catch((e: any) => console.warn('[ResumeService] Failed to update status after upload error:', e?.message));
      throw new ResumeProcessingError(`Failed to upload resume: ${uploadError?.message}`, uploadError);
    }

    // Step 2: Try AI parsing (failures don't break the upload)
    let parseResult: any = null;
    let aiExtracted: any = {};
    let parsingSuccess = false;

    try {
      console.log(`[ResumeService] Starting AI parsing...`);
      parseResult = await this.aiResumeParser.parseFile(fileBuffer, mimetype);
      aiExtracted = parseResult?.aiExtracted || {};
      parsingSuccess = (
        (aiExtracted.skills?.technical?.length > 0) ||
        (aiExtracted.skills?.soft?.length > 0) ||
        (aiExtracted.skills?.tools?.length > 0)
      );
      const totalSkills = (aiExtracted.skills?.technical?.length || 0) +
        (aiExtracted.skills?.soft?.length || 0) +
        (aiExtracted.skills?.tools?.length || 0);
      console.log(`[ResumeService] AI parsing completed:`, {
        hasText: !!parseResult?.text,
        textLength: parseResult?.text?.length || 0,
        technicalSkills: aiExtracted.skills?.technical?.length || 0,
        softSkills: aiExtracted.skills?.soft?.length || 0,
        toolSkills: aiExtracted.skills?.tools?.length || 0,
        totalSkills,
        confidence: parseResult?.confidence || 0,
        extractor: parseResult?.extractor,
        degraded: parseResult?.degraded,
        parsingSuccess
      });
      this.reportParseProvenance(userId, parseResult, totalSkills);
    } catch (parseError: any) {
      console.error(`[ResumeService] AI parsing failed (non-fatal):`, {
        error: parseError?.message,
        stack: parseError?.stack?.split('\n').slice(0, 3).join('\n')
      });
      // Continue - upload succeeded, parsing failed
    }

    const processingTime = Date.now() - startTime;

    // Step 3: Build and save profile update
    try {
      const profileUpdate: any = {
        userId,
        resumeUrl,
        resumeProcessingStatus: parsingSuccess ? 'completed' : 'failed',
        parsedAt: new Date(),
        resumeParsingData: {
          confidence: parseResult?.confidence || 0,
          processingTime,
          // Provenance: which engine produced this, and whether a better one
          // was tried and failed. Without it, a parse from the rule engine
          // (0/7 positions on a PDF) is indistinguishable from a clean one.
          extractor: parseResult?.extractor ?? 'none',
          degraded: parseResult?.degraded ?? true,
          ...(parseResult?.primaryError ? { primaryError: parseResult.primaryError } : {}),
          parsedWithModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
          extractedSkillsCount: (aiExtracted.skills?.technical?.length || 0) +
            (aiExtracted.skills?.soft?.length || 0) +
            (aiExtracted.skills?.tools?.length || 0),
          parsingError: parsingSuccess ? null : 'AI parsing failed',
          // Store structured positions so matching can compare job titles
          positions: (aiExtracted.experience?.positions || []).slice(0, 6).map((p: any) => ({
            title: p.title || '',
            company: p.company || '',
            duration: p.duration || '',
          })),
        },
      };

      // Only overwrite resumeText if we actually got content — don't nuke existing text on parse failure
      if (parseResult?.text) {
        profileUpdate.resumeText = parseResult.text;
      }

      // Skills: always wipe and replace on re-upload — stale skills pollute matches
      const extractedSkills = [
        ...(aiExtracted.skills?.technical || []),
        ...(aiExtracted.skills?.soft || []),
        ...(aiExtracted.skills?.tools || []),
      ];
      profileUpdate.skills = extractedSkills.length > 0
        ? normalizeSkills(extractedSkills).slice(0, 30)
        : [];

      if (aiExtracted.experience?.level) {
        profileUpdate.experienceLevel = aiExtracted.experience.level;
      }
      // Build free-text experience summary from positions so scoreJobWithML has semantic signal
      const positions: Array<{ title?: string; company?: string; duration?: string; description?: string }> =
        aiExtracted.experience?.positions || [];
      if (positions.length > 0) {
        const summary = positions.slice(0, 6).map((p: any) =>
          [p.title, p.company, p.duration, p.description].filter(Boolean).join(' ')
        ).join('. ');
        profileUpdate.experience = summary.slice(0, 2000);
        profileUpdate.resumeParsingData = {
          ...profileUpdate.resumeParsingData,
          positions: positions.slice(0, 6).map((p: any) => ({
            title: p.title || '',
            company: p.company || '',
            duration: p.duration || '',
          })),
        };
        // Derive headline from most recent position so it stays in sync with the resume
        const latestTitle = positions[0]?.title?.trim();
        const latestCompany = positions[0]?.company?.trim();
        if (latestTitle) {
          profileUpdate.summary = latestCompany
            ? `${latestTitle} at ${latestCompany}`
            : latestTitle;
        }
      }
      // NOTE: Do NOT auto-fill location from resume — it often incorrectly
      // pulls city names from skill descriptions (e.g., "React" → "Austin").
      // Users should set location manually via preferences.
      // if (aiExtracted.personalInfo?.location) {
      //   profileUpdate.location = aiExtracted.personalInfo.location;
      // }
      if (aiExtracted.personalInfo?.linkedin) {
        profileUpdate.linkedinUrl = aiExtracted.personalInfo.linkedin;
      }
      if (aiExtracted.personalInfo?.github) {
        profileUpdate.githubUrl = aiExtracted.personalInfo.github;
      }

      // Strip null bytes from ALL string fields at the boundary — PostgreSQL
      // rejects \0 in UTF-8 text/jsonb columns. Doing it once here instead of
      // scattering .replace(/\0/g, '') on individual fields.
      stripNullBytes(profileUpdate);

      await this.storage.upsertCandidateUser(profileUpdate);
      console.log(`[ResumeService] Profile updated for user: ${userId}`);

      // Mark the embedding stale; the VPS cron recomputes it. NOT computed here:
      // this runs on Vercel, which can only reach the Gemini provider, while jobs
      // are embedded locally on the VPS — embedding here would put the candidate
      // in a different vector space than every job. See candidate-embedding.service.
      if (extractedSkills.length > 0) {
        invalidateCandidateEmbedding(userId)
          .catch((e: any) => console.warn('[ResumeService] Embedding invalidation failed:', e?.message));
      }

      // Warm-compute job matches in background (non-blocking).
      // Inngest is disabled (no INNGEST_EVENT_KEY), so call scoring directly.
      // This ensures matches are ready when the candidate views their dashboard.
      if (parsingSuccess) {
        this.storage.getJobRecommendations(userId)
          .then((result: any) => console.log(`[ResumeService] Warm-computed ${result?.jobs?.length || 0} matches for ${userId}`))
          .catch((e: any) => console.warn('[ResumeService] Match warming failed (non-fatal):', e?.message));
      }

      // Log activity
      await this.storage.createActivityLog(
        userId,
        parsingSuccess ? "resume_parsing_complete" : "resume_upload_complete",
        parsingSuccess
          ? `Resume parsed with ${parseResult?.confidence || 0}% confidence. Extracted ${extractedSkills.length} skills.`
          : `Resume uploaded. AI parsing failed - you can add skills manually.`
      ).catch((e: any) => console.warn('[ResumeService] Failed to create activity log:', e?.message));

    } catch (saveError: any) {
      console.error(`[ResumeService] Failed to save profile:`, saveError);
      await captureException(saveError instanceof Error ? saveError : new Error(saveError?.message || 'Profile save failed'), {
        userId,
        action: 'POST /api/candidate/resume',
        component: 'resume-service',
        metadata: { step: 'profile-save', resumeUrl },
      });
      // Still return success since file was uploaded
    }

    // Return results (always succeeds if upload succeeded)
    return {
      resumeUrl,
      parsed: parsingSuccess,
      aiParsing: {
        success: parsingSuccess,
        confidence: parseResult?.confidence || 0,
        processingTime,
      },
      extractedInfo: parsingSuccess ? {
        // Full extracted data for display
        skills: {
          technical: aiExtracted.skills?.technical || [],
          soft: aiExtracted.skills?.soft || [],
          tools: aiExtracted.skills?.tools || []
        },
        experience: {
          level: aiExtracted.experience?.level || 'unknown',
          years: aiExtracted.experience?.totalYears || 0,
          positions: aiExtracted.experience?.positions || []
        },
        education: aiExtracted.education || [],
        certifications: aiExtracted.certifications || [],
        projects: aiExtracted.projects || [],
        personalInfo: {
          name: aiExtracted.personalInfo?.name || '',
          email: aiExtracted.personalInfo?.email || '',
          phone: aiExtracted.personalInfo?.phone || '',
          location: aiExtracted.personalInfo?.location || '',
          linkedin: aiExtracted.personalInfo?.linkedin || '',
          github: aiExtracted.personalInfo?.github || '',
          website: aiExtracted.personalInfo?.website || ''
        },
        // Summary counts
        skillsCount: (aiExtracted.skills?.technical?.length || 0) +
          (aiExtracted.skills?.soft?.length || 0) +
          (aiExtracted.skills?.tools?.length || 0),
        workHistoryCount: aiExtracted.experience?.positions?.length || 0,
        educationCount: aiExtracted.education?.length || 0,
        certificationsCount: aiExtracted.certifications?.length || 0,
        projectsCount: aiExtracted.projects?.length || 0,
      } : null,
      autoMatchingTriggered: parsingSuccess,
    };
  }

  /**
   * Retry a failed resume parse for a candidate.
   * Increments parseAttempts FIRST so a crash doesn't cause infinite retries.
   */
  async retryFailedParse(
    userId: string,
    resumeUrl: string
  ): Promise<{ userId: string; success: boolean; skills: number; error?: string }> {
    console.log(`[ResumeService] Retrying failed parse for user: ${userId}, url: ${resumeUrl}`);

    // Increment attempts before retrying — crash-safe
    await this.storage.incrementParseAttempts(userId);

    try {
      // Resolve storage path → signed URL, then download
      const signedUrl = await this.storage.getResumeSignedUrl(resumeUrl);
      const response = await fetch(signedUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch resume: HTTP ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const fileBuffer = Buffer.from(arrayBuffer);

      // Infer mimetype from storage path extension (strip query params from signed URL)
      const ext = resumeUrl.split('.').pop()?.toLowerCase();
      let mimetype = 'application/pdf';
      if (ext === 'docx') {
        mimetype = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      }

      // Run AI parsing
      const parseResult = await this.aiResumeParser.parseFile(fileBuffer, mimetype);
      const aiExtracted = parseResult?.aiExtracted || {};
      
      // Success = parse completed without crash, even if 0 skills extracted
      // (scanned PDFs with rule-based parsing may return 0 skills but profile is still saved)
      const hasAnyData = Boolean(
        (aiExtracted.skills?.technical?.length > 0) ||
        (aiExtracted.skills?.soft?.length > 0) ||
        (aiExtracted.skills?.tools?.length > 0) ||
        (aiExtracted.personalInfo?.name) ||
        (aiExtracted.personalInfo?.email) ||
        (aiExtracted.experience?.positions?.length > 0) ||
        (aiExtracted.education?.length > 0)
      );
      const parsingSuccess = hasAnyData;
      this.reportParseProvenance(userId, parseResult, extractedSkillsCount(aiExtracted));

      const extractedSkills = [
        ...(aiExtracted.skills?.technical || []),
        ...(aiExtracted.skills?.soft || []),
        ...(aiExtracted.skills?.tools || []),
      ];

      // Build profile update
      const profileUpdate: any = {
        userId,
        resumeProcessingStatus: parsingSuccess ? 'completed' : 'failed',
        parsedAt: new Date(),
        resumeParsingData: {
          confidence: parseResult?.confidence || 0,
          processingTime: 0,
          extractedSkillsCount: extractedSkills.length,
          extractor: parseResult?.extractor ?? 'none',
          degraded: parseResult?.degraded ?? true,
          ...(parseResult?.primaryError ? { primaryError: parseResult.primaryError } : {}),
          parsedWithModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
          parsingError: parsingSuccess ? null : 'AI parsing failed on retry',
          positions: (aiExtracted.experience?.positions || []).slice(0, 6).map((p: any) => ({
            title: p.title || '',
            company: p.company || '',
            duration: p.duration || '',
          })),
        },
      };

      if (parseResult?.text) {
        profileUpdate.resumeText = parseResult.text;
      }
      // Skills: always wipe and replace on retry — stale skills pollute matches
      profileUpdate.skills = extractedSkills.length > 0
        ? normalizeSkills(extractedSkills).slice(0, 30)
        : [];
      if (aiExtracted.experience?.level) {
        profileUpdate.experienceLevel = aiExtracted.experience.level;
      }
      const positions: Array<{ title?: string; company?: string; duration?: string; description?: string }> =
        aiExtracted.experience?.positions || [];
      if (positions.length > 0) {
        const summary = positions.slice(0, 6).map((p: any) =>
          [p.title, p.company, p.duration, p.description].filter(Boolean).join(' ')
        ).join('. ');
        profileUpdate.experience = summary.slice(0, 2000);
        // Derive headline from most recent position so it stays in sync with the resume
        const latestTitle = positions[0]?.title?.trim();
        const latestCompany = positions[0]?.company?.trim();
        if (latestTitle) {
          profileUpdate.summary = latestCompany
            ? `${latestTitle} at ${latestCompany}`
            : latestTitle;
        }
      }
      // NOTE: Do NOT auto-fill location from resume — it often incorrectly
      // pulls city names from skill descriptions (e.g., "React" → "Austin").
      // Users should set location manually via preferences.
      // if (aiExtracted.personalInfo?.location) {
      //   profileUpdate.location = aiExtracted.personalInfo.location;
      // }
      if (aiExtracted.personalInfo?.linkedin) {
        profileUpdate.linkedinUrl = aiExtracted.personalInfo.linkedin;
      }
      if (aiExtracted.personalInfo?.github) {
        profileUpdate.githubUrl = aiExtracted.personalInfo.github;
      }

      await this.storage.upsertCandidateUser(profileUpdate);

      // Mark the embedding stale; the VPS cron recomputes it. NOT computed here:
      // this runs on Vercel, which can only reach the Gemini provider, while jobs
      // are embedded locally on the VPS — embedding here would put the candidate
      // in a different vector space than every job. See candidate-embedding.service.
      if (extractedSkills.length > 0) {
        invalidateCandidateEmbedding(userId)
          .catch((e: any) => console.warn('[ResumeService] Embedding invalidation failed:', e?.message));
      }

      // Fire match warming on success
      if (parsingSuccess) {
        sendInngestEvent('candidate/profile-updated', { candidateId: userId }).catch(() => {});
      }

      console.log(`[ResumeService] Retry parse for ${userId}: success=${parsingSuccess}, skills=${extractedSkills.length}`);
      return { userId, success: parsingSuccess, skills: extractedSkills.length };
    } catch (error: any) {
      console.error(`[ResumeService] Retry parse failed for ${userId}:`, error?.message);
      // Status remains 'failed'; parseAttempts already incremented
      return { userId, success: false, skills: 0, error: error?.message };
    }
  }

}
