/**
 * Storage Layer for Recrutas Platform
 * 
 * This module provides a comprehensive data access layer implementing the Repository pattern.
 * It handles all database interactions while maintaining clean separation between
 * business logic and data persistence.
 * 
 * Key Features:
 * - Type-safe database operations using Drizzle ORM
 * - Comprehensive CRUD operations for all entities
 * - Advanced querying with filtering and pagination
 * - Transaction support for complex operations
 * - Error handling and data validation
 * 
 * Architecture:
 * - IStorage interface defines the contract
 * - DatabaseStorage implements the interface
 * - All methods are async and return Promise-based results
 * - Uses dependency injection pattern for testability
 */

import {
  users,
  candidateProfiles,
  jobPostings,
  jobMatches,
  chatRooms,
  chatMessages,
  activityLogs,
  notifications,
  examAttempts,
  jobExams,
  notificationPreferences,
  jobApplications,
  savedJobs,
  hiddenJobs,
  talentOwnerProfiles,
  interviews,
  screeningQuestions,
  screeningAnswers,
  type User,
  type UpsertUser,
  type CandidateProfile,
  type InsertCandidateProfile,
  type TalentOwnerProfile,
  type InsertTalentOwnerProfile,
  type JobPosting,
  type InsertJobPosting,
  type JobMatch,
  type InsertJobMatch,
  type ChatRoom,
  type ChatMessage,
  type InsertChatMessage,
  type ActivityLog,
  type NotificationPreferences,
  type InsertNotificationPreferences,
  inviteCodes,
  inviteCodeRedemptions,
  dailyUsageLimits,
} from "../shared/schema.js";
import { db, client } from "./db";
import { eq, desc, asc, and, or } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { sql } from "drizzle-orm/sql";
import { inArray } from "drizzle-orm/sql/expressions";
import { supabaseAdmin } from "./lib/supabase-admin";
import { normalizeSkills, parseSkillsInput } from "./skill-normalizer";
import { scoreJob, computeRecencyScore, getFreshnessLabel, inferJobLevel, getRoleTitleKeywords } from "./job-scorer";

/**
 * Storage Interface Definition
 * 
 * Defines the contract for all data access operations across the platform.
 * This interface ensures consistency and enables easy testing through mocking.
 */
export interface IStorage {
  // User operations (required for Replit Auth)
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;
  updateUserInfo(userId: string, userInfo: any): Promise<any>;
  updateUserRole(userId: string, role: 'candidate' | 'talent_owner'): Promise<User>;




  // Candidate operations
  getCandidateUser(userId: string): Promise<CandidateProfile | undefined>;
  upsertCandidateUser(profile: InsertCandidateProfile): Promise<CandidateProfile>;
  getAllCandidateUsers(): Promise<CandidateProfile[]>;
  getCandidatesForParseRetry(limit: number): Promise<CandidateProfile[]>;
  incrementParseAttempts(userId: string): Promise<void>;

  // Talent Owner operations
  getTalentOwnerProfile(userId: string): Promise<TalentOwnerProfile | undefined>;
  upsertTalentOwnerProfile(profile: InsertTalentOwnerProfile): Promise<TalentOwnerProfile>;


  // Job operations
  createJobPosting(job: InsertJobPosting): Promise<JobPosting>;
  getJobPostings(recruiterId: string): Promise<JobPosting[]>;
  getJobPosting(id: number): Promise<JobPosting | undefined>;
  getJobRecommendations(candidateId: string, filters?: { jobTitle?: string; location?: string; workType?: string }, pagination?: { page: number; limit: number }): Promise<{ jobs: any[]; total: number; page: number; hasMore: boolean }>;
  getDiscoveryFeedForCandidate(candidateId: string): Promise<any[]>;
  updateJobPosting(id: number, talentOwnerId: string, updates: Partial<InsertJobPosting>): Promise<JobPosting>;
  deleteJobPosting(id: number, talentOwnerId: string): Promise<void>;


  // Matching operations
  createJobMatch(match: InsertJobMatch): Promise<JobMatch>;
  getMatchesForCandidate(candidateId: string): Promise<(JobMatch & { job: JobPosting; talentOwner: User })[]>;
  getMatchesForJob(jobId: number): Promise<(JobMatch & { candidate: User; candidateProfile?: CandidateProfile })[]>;
  updateMatchStatus(matchId: number, status: string): Promise<JobMatch>;
  clearJobMatches(jobId: number): Promise<void>;
  updateJobMatchStatus(candidateId: string, jobId: number, status: string): Promise<void>;

  // Exam operations
  createJobExam(exam: any): Promise<any>;
  getJobExam(jobId: number): Promise<any>;
  createExamAttempt(attempt: any): Promise<any>;
  updateExamAttempt(attemptId: number, data: any): Promise<any>;
  getExamAttempts(jobId: number): Promise<any[]>;
  rankCandidatesByExamScore(jobId: number): Promise<void>;
  closeJobAndNotifyCandidates(jobId: number, talentOwnerId: string): Promise<void>;

  // Chat operations (controlled by exam performance)
  createChatRoom(data: any): Promise<ChatRoom>;
  getChatRoom(jobId: number, candidateId: string): Promise<ChatRoom | undefined>;
  getChatMessages(chatRoomId: number): Promise<(ChatMessage & { sender: User })[]>;
  createChatMessage(message: InsertChatMessage): Promise<ChatMessage>;
  getChatRoomsForUser(userId: string): Promise<(ChatRoom & { job: JobPosting; hiringManager: User })[]>;
  grantChatAccess(jobId: number, candidateId: string, examAttemptId: number, ranking: number): Promise<ChatRoom>;

  // Activity operations
  createActivityLog(userId: string, type: string, description: string, metadata?: any): Promise<ActivityLog>;
  getActivityLogs(userId: string, limit?: number): Promise<ActivityLog[]>;

  // Application tracking operations
  getApplicationsWithStatus(candidateId: string): Promise<any[]>;
  getApplicantsForJob(jobId: number, talentOwnerId: string): Promise<any[]>;
  updateApplicationStatus(applicationId: number, status: string, talentOwnerId: string): Promise<any>;
  updateApplicationStatusByCandidate(applicationId: number, status: string): Promise<any>;
  getApplicationByJobAndCandidate(jobId: number, candidateId: string): Promise<any>;
  createJobApplication(application: any): Promise<any>;
  getApplicationById(applicationId: number): Promise<any>;
  createApplicationEvent(event: any): Promise<any>;
  getApplicationEvents(applicationId: number): Promise<any[]>;
  getApplicationInsights(applicationId: number): Promise<any>;
  createApplicationInsights(insights: any): Promise<any>;
  updateApplicationIntelligence(applicationId: number, updates: any): Promise<any>;
  getApplicationsForTalent(talentId: string): Promise<any[]>;
  updateTalentTransparencySettings(talentId: string, settings: any): Promise<any>;
  storeExamResult(result: any): Promise<any>;
  getOverdueExamApplications(): Promise<{ applicationId: number; candidateId: string; jobTitle: string; company: string }[]>;
  getApplicationsNearSLADeadline(hoursWindow: number): Promise<{ applicationId: number; candidateId: string; talentOwnerId: string; jobTitle: string; company: string; hoursLeft: number }[]>;
  getStaleInternalJobs(staleDays?: number): Promise<{ id: number; title: string; company: string; createdAt: Date | null }[]>;
  closeJobsByIds(ids: number[]): Promise<number>;
  getAvailableNotificationUsers(): Promise<string[]>;


  // Statistics
  getJobStatistics(): Promise<any>;
  getCandidateStats(candidateId: string): Promise<{
    totalApplications: number;
    activeMatches: number;
    profileViews: number;
    profileStrength: number;
    responseRate: number;
    avgMatchScore: number;
  }>;
  getRecruiterStats(recruiterId: string): Promise<{
    activeJobs: number;
    totalMatches: number;
    activeChats: number;
    hires: number;
  }>;
  getCandidatesForRecruiter(talentOwnerId: string): Promise<any[]>;

  // Notification preferences
  getNotificationPreferences(userId: string): Promise<NotificationPreferences | undefined>;
  updateNotificationPreferences(userId: string, preferences: Partial<InsertNotificationPreferences>): Promise<NotificationPreferences>;

  // Notification operations
  getNotifications(userId: string): Promise<any[]>;
  markNotificationAsRead(notificationId: number, userId: string): Promise<void>;
  markAllNotificationsAsRead(userId: string): Promise<void>;
  createNotification(notification: any): Promise<any>;

  // Enhanced candidate operations
  getApplicationsForCandidate(candidateId: string): Promise<any[]>;
  getActivityForCandidate(candidateId: string): Promise<any[]>;
  saveJob(userId: string, jobId: number): Promise<void>;
  unsaveJob(userId: string, jobId: number): Promise<void>;
  hideJob(userId: string, jobId: number): Promise<void>;
  getSavedJobIds(userId: string): Promise<number[]>;
  getHiddenJobIds(userId: string): Promise<number[]>;
  // Discover operations
  findMatchingCandidates(jobId: number): Promise<any[]>;

  // Interview operations
  createInterview(interview: any): Promise<any>;

  // File operations
  uploadResume(fileBuffer: Buffer, mimetype: string): Promise<string>;
  getResumeSignedUrl(resumePath: string): Promise<string>;

  // Screening questions operations
  getScreeningQuestions(jobId: number): Promise<any[]>;
  saveScreeningQuestions(jobId: number, questions: any[]): Promise<any[]>;
  saveScreeningAnswers(applicationId: number, answers: any[]): Promise<any[]>;

  // Invite code operations
  validateAndRedeemInviteCode(code: string, userId: string, role: string): Promise<{ valid: boolean; error?: string }>;
  createInviteCode(data: { code: string; description?: string; role?: string; maxUses?: number; createdBy?: string; expiresAt?: Date }): Promise<any>;
  listInviteCodes(): Promise<any[]>;

  // Daily usage limit operations
  checkDailyLimit(userId: string, action: string, limit: number): Promise<{ allowed: boolean; used: number; limit: number }>;
  incrementDailyUsage(userId: string, action: string): Promise<void>;
}

// Sources that publish directly from company ATSs (not aggregators)
// Sources that represent a direct-from-company scrape (deep link to the
// company's actual ATS posting). The scrape-all-company-jobs script emits
// `ATS:<atsType>` while the older adzuna-migration scripts emit the bare
// `<atsType>` — both forms accepted here. `isFromAts()` does the matching.
const ATS_SOURCES = new Set([
  'greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'workday',
  'ATS:greenhouse', 'ATS:lever', 'ATS:ashby', 'ATS:workable', 'ATS:recruitee',
  'company-api', 'platform',
]);
function isFromAts(source: string | null | undefined): boolean {
  if (!source) return false;
  return ATS_SOURCES.has(source) || ATS_SOURCES.has(source.toLowerCase());
}

// Escape regex metacharacters so a user-supplied skill (e.g. ".NET", "C++") can be
// safely embedded inside a Postgres POSIX regex pattern.
function escapePgRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Escape LIKE/ILIKE wildcards so a term is matched literally (default '\' escape).
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

// Job board aggregators — excluded from the candidate feed (links don't go to actual job pages)
const AGGREGATOR_SOURCES = new Set(['Adzuna', 'JSearch', 'Jooble', 'Indeed', 'ArbeitNow', 'USAJobs', 'RemoteOK', 'WeWorkRemotely', 'The Muse']);
// URL patterns that identify aggregator apply links
const AGGREGATOR_URL_PATTERNS = ['adzuna', 'jooble', 'jsearch', 'indeed.com', 'usajobs.gov', 'arbeitnow', 'remoteok.io', 'weworkremotely.com', 'themuse.com'];
// SQL fragment: exclude any external_url that routes through an aggregator
const aggregatorUrlExclusion = sql`(
  ${jobPostings.externalUrl} IS NULL
  OR NOT (${sql.join(
    AGGREGATOR_URL_PATTERNS.map(p => sql`${jobPostings.externalUrl} ILIKE ${'%' + p + '%'}`),
    sql` OR `
  )})
)`;

// JS mirror of usPriorityOrder. Keep in sync with the SQL CASE below — both
// must agree so the post-scoring re-sort produces the same tier ordering as
// the initial SQL retrieval.
// Full US state name list — used so "Remote - California", "Florida-Remote",
// "Remote, Texas" and other state-named variants land in bucket 0.
// "georgia" excluded because it ambiguously matches the country Georgia.
const US_STATE_NAMES_RE_PART =
  'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia';

// US state code alternation — used so the ", XX" suffix check only matches actual
// US states. Without this, foreign codes like "NL" (Nuevo León), "ON" (Ontario),
// "QC" (Québec) trip the City/State regex and bucket as US.
const US_STATE_CODES_RE_PART =
  'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';

// Canadian province codes — none overlap with US state codes. Used to drop
// "City, ST" rows like "Markham, ON" / "Vancouver, BC" that otherwise read
// as ambiguous-US.
const CA_PROVINCE_CODES_RE_PART = 'ON|QC|BC|AB|MB|SK|NB|PE|YT|NU|NS|NL|NT';

function jsUsLocationPriority(job: { source?: string | null; location?: string | null }): number {
  if ((job.source ?? '') === 'platform') return 0;
  const loc = (job.location ?? '').trim();
  if (!loc) return 1;
  const lower = loc.toLowerCase();
  // Non-US keywords (must mirror NON_US_LOCATION_REGEX). "latin america",
  // "costa rica", "united arab emirates" added so common variants don't
  // fall through to the US-remote check.
  const NON_US_RE = /\b(europe|european|emea|apac|latam|latin america|united kingdom|\buk\b|england|scotland|wales|london|manchester|edinburgh|birmingham|glasgow|bristol|leeds|cambridge|oxford|germany|berlin|munich|münchen|muenchen|frankfurt|hamburg|cologne|köln|koeln|dresden|stuttgart|düsseldorf|dusseldorf|france|paris|lyon|marseille|toulouse|nantes|lille|netherlands|amsterdam|rotterdam|eindhoven|utrecht|the hague|den haag|tilburg|breda|nijmegen|groningen|zwolle|goes|almere|den bosch|s-hertogenbosch|spain|madrid|barcelona|valencia|seville|sevilla|bilbao|italy|milan|milano|rome|roma|turin|torino|florence|firenze|naples|napoli|portugal|lisbon|lisboa|porto|ireland|dublin|cork|galway|sweden|stockholm|gothenburg|norway|oslo|denmark|copenhagen|finland|helsinki|poland|warsaw|krakow|wroclaw|czech|prague|austria|vienna|switzerland|zurich|geneva|belgium|brussels|antwerp|romania|bucharest|sofia|bulgaria|hungary|budapest|greece|athens|turkey|istanbul|ukraine|russia|moscow|israel|tel aviv|uae|united arab emirates|dubai|abu dhabi|qatar|saudi|jordan|lebanon|cairo|egypt|south africa|nigeria|kenya|canada|toronto|vancouver|montreal|ottawa|calgary|edmonton|winnipeg|halifax|quebec city|costa rica|guatemala|honduras|nicaragua|el salvador|panama|mexico city|monterrey|guadalajara|tijuana|juarez|puebla|queretaro|brazil|s[aã]o paulo|argentina|buenos aires|chile|santiago|colombia|bogota|peru|lima|australia|sydney|melbourne|brisbane|perth|new zealand|auckland|india|bangalore|bengaluru|mumbai|hyderabad|delhi|pune|gurugram|gurgaon|noida|chennai|kolkata|kochi|ahmedabad|pakistan|karachi|bangladesh|china|beijing|shanghai|hong kong|taiwan|taipei|japan|tokyo|south korea|seoul|singapore|malaysia|kuala lumpur|indonesia|jakarta|thailand|bangkok|vietnam|ho chi minh|hanoi|philippines|manila)\b/;
  if (NON_US_RE.test(lower)) return 2;
  // Country-suffix detection for "mexico" — collides with the US state "New
  // Mexico", so strip "new mexico" first, then test for the country name.
  // Catches "Foo, Mexico", "Remote - Mexico", "Mexico - Remote", etc.
  if (/\bmexico\b/.test(lower.replace(/new mexico/g, ''))) return 2;
  // Canadian province code suffix — "Markham, ON", "Vancouver, BC".
  if (new RegExp(`, ?(${CA_PROVINCE_CODES_RE_PART})( |,|$)`).test(loc)) return 2;
  // US-explicit: bare US tokens, NA shorthand, or any full state name.
  // \bus\b is safe — it won't match inside Belarus/Houston/Russia (no word boundary).
  if (/\b(us|usa|u\.s\.|united states|north america|americas)\b/.test(lower)) return 0;
  if (new RegExp(`\\b(${US_STATE_NAMES_RE_PART})\\b`).test(lower)) return 0;
  // City, US-state-code suffix — validate the 2-letter code against the
  // actual US state codes (so "Monterrey, NL" / "Markham, ON" don't pass).
  if (new RegExp(`, ?(${US_STATE_CODES_RE_PART})( |,|$)`).test(loc)) return 0;
  if (['remote', 'various', 'worldwide', 'global'].includes(lower)) return 1;
  return 1;
}

// SQL ORDER BY helper: rank rows by US affinity (lower = higher in feed).
//   0 → location explicitly looks US (state code suffix, "USA", "US Remote",
//        "Remote - US", "Remote, North America", etc.)
//   1 → unknown / ambiguous (empty location, plain "Remote", "Various")
//   2 → location explicitly looks non-US
// Used as a primary ORDER BY across the feed paths so US jobs surface first
// without dropping non-US rows entirely.
const NON_US_LOCATION_REGEX =
  '\\m(europe|european|emea|apac|latam|latin america|united kingdom|uk|england|scotland|wales|london|manchester|edinburgh|birmingham|glasgow|bristol|leeds|cambridge|oxford|germany|berlin|munich|münchen|muenchen|frankfurt|hamburg|cologne|köln|koeln|dresden|stuttgart|düsseldorf|dusseldorf|france|paris|lyon|marseille|toulouse|nantes|lille|netherlands|amsterdam|rotterdam|eindhoven|utrecht|the hague|den haag|tilburg|breda|nijmegen|groningen|zwolle|goes|almere|den bosch|s-hertogenbosch|spain|madrid|barcelona|valencia|seville|sevilla|bilbao|italy|milan|milano|rome|roma|turin|torino|florence|firenze|naples|napoli|portugal|lisbon|lisboa|porto|ireland|dublin|cork|galway|sweden|stockholm|gothenburg|norway|oslo|denmark|copenhagen|finland|helsinki|poland|warsaw|krakow|wroclaw|czech|prague|austria|vienna|switzerland|zurich|geneva|belgium|brussels|antwerp|romania|bucharest|sofia|bulgaria|hungary|budapest|greece|athens|turkey|istanbul|ukraine|russia|moscow|israel|tel aviv|uae|united arab emirates|dubai|abu dhabi|qatar|saudi|jordan|lebanon|cairo|egypt|south africa|nigeria|kenya|canada|toronto|vancouver|montreal|ottawa|calgary|edmonton|winnipeg|halifax|quebec city|costa rica|guatemala|honduras|nicaragua|el salvador|panama|mexico city|monterrey|guadalajara|tijuana|juarez|puebla|queretaro|brazil|são paulo|sao paulo|argentina|buenos aires|chile|santiago|colombia|bogota|bogotá|peru|lima|australia|sydney|melbourne|brisbane|perth|new zealand|auckland|india|bangalore|bengaluru|mumbai|hyderabad|delhi|pune|gurugram|gurgaon|noida|chennai|kolkata|kochi|ahmedabad|pakistan|karachi|bangladesh|china|beijing|shanghai|hong kong|taiwan|taipei|japan|tokyo|south korea|seoul|singapore|malaysia|kuala lumpur|indonesia|jakarta|thailand|bangkok|vietnam|ho chi minh|hanoi|philippines|manila)\\M';
// "Mexico" detection — collides with the US state "New Mexico". The filter
// path uses regexp_replace to strip "new mexico" before matching, so this
// catches "Foo, Mexico" / "Remote - Mexico" without flagging "New Mexico".
// (Cannot live in NON_US_LOCATION_REGEX because alternation matches "mexico"
// inside "new mexico" via word boundaries.)
const MEXICO_COUNTRY_REGEX = '\\mmexico\\M';
const usPriorityOrder = sql`CASE
  WHEN ${jobPostings.source} = 'platform' THEN 0
  WHEN ${jobPostings.location} ~* ${NON_US_LOCATION_REGEX} THEN 2
  WHEN regexp_replace(LOWER(${jobPostings.location}), 'new mexico', '', 'g') ~* ${MEXICO_COUNTRY_REGEX} THEN 2
  WHEN ${jobPostings.location} ~* ${', ?(' + CA_PROVINCE_CODES_RE_PART + ')( |,|$)'} THEN 2
  WHEN ${jobPostings.location} ~* '\\m(us|usa|u\\.s\\.|united states|north america|americas)\\M' THEN 0
  WHEN ${jobPostings.location} ~* ${'\\m(' + US_STATE_NAMES_RE_PART + ')\\M'} THEN 0
  WHEN ${jobPostings.location} ~* ${', ?(' + US_STATE_CODES_RE_PART + ')( |,|$)'} THEN 0
  WHEN ${jobPostings.location} IS NULL OR TRIM(${jobPostings.location}) = '' THEN 1
  WHEN LOWER(${jobPostings.location}) IN ('remote','various','worldwide','global') THEN 1
  ELSE 1
END`;

// SQL fragment: require external_url to look like a real job post page.
// Excludes bare-domain roots (e.g. https://rrmc.org — Adzuna fallback from
// migrate-adzuna-fallbacks.ts) and any URL that lacks a job-post marker:
// a job id (≥4 digits in the path/query), a recognized ATS query param
// (gh_jid, jobid, requisition, posting), a /job/ or /jobs/<long-slug>
// segment, or a known ATS host. Generic careers landings like
// https://example.com/careers fail the marker check and are dropped.
// Internal (source = 'platform') jobs have no external_url and must be
// allowed through separately at each call site.
const jobPostUrlRequirement = sql`(
  ${jobPostings.externalUrl} IS NOT NULL
  AND NOT (${jobPostings.externalUrl} ~ '^https?://[^/]+/?$')
  AND (
    ${jobPostings.externalUrl} ~ '[/?][^/?#]*\\d{4,}'
    OR ${jobPostings.externalUrl} ~* '(gh_jid|jobid|requisition|posting|/job/|/jobs/[a-z0-9_-]{8,})'
    OR ${jobPostings.externalUrl} ~* '(boards\\.greenhouse\\.io|job-boards\\.greenhouse\\.io|jobs\\.lever\\.co|jobs\\.ashbyhq\\.com|\\.recruitee\\.com|\\.workable\\.com|\\.bamboohr\\.com|myworkdayjobs\\.com|smartrecruiters\\.com|icims\\.com|taleo\\.net)'
  )
)`;

/**
 * Database Storage Implementation
 *
 * Implements the IStorage interface using Drizzle ORM for PostgreSQL.
 * Provides production-ready data access with proper error handling,
 * transaction support, and optimized queries.
 */
export class DatabaseStorage implements IStorage {

  // User operations (required for Replit Auth)
  async getUser(id: string): Promise<User | undefined> {
    try {
      console.log(`[storage] Getting user with id: ${id}`);
      const [user] = await db.select().from(users).where(eq(users.id, id));
      console.log(`[storage] Found user:`, user);
      return user;
    } catch (error) {
      console.error('Error fetching user:', error);
      throw error;
    }
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    try {
      const [user] = await db
        .insert(users)
        .values(userData)
        .onConflictDoUpdate({
          target: users.id,
          set: {
            ...userData,
            updatedAt: new Date(),
          },
        })
        .returning();
      return user;
    } catch (error) {
      console.error('Error upserting user:', error);
      throw error;
    }
  }

  async updateUserRole(userId: string, role: 'candidate' | 'talent_owner'): Promise<User> {
    try {
      // First, update the user's metadata in Supabase Auth
      const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.updateUserById(
        userId,
        { app_metadata: { role } }
      );

      if (authError) {
        console.error('Error updating Supabase auth user:', authError);
        throw new Error(authError.message);
      }

      // Then, update the local database for consistency
      const [user] = await db
        .update(users)
        .set({ role: role as any, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning();

      if (!user) {
        throw new Error("User not found in local database after role update.");
      }

      return user;
    } catch (error) {
      console.error('Error updating user role:', error);
      throw error;
    }
  }

  async uploadResume(fileBuffer: Buffer, fileType: string): Promise<string> {
    try {
      const bucket = 'resumes';
      const fileName = `resume-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
      const { data, error } = await supabaseAdmin.storage
        .from(bucket)
        .upload(fileName, fileBuffer, {
          contentType: fileType,
          upsert: true,
        });

      if (error) {
        console.error('Error uploading to Supabase Storage:', error);
        throw new Error('Failed to upload resume to storage.');
      }

      // Return the file path instead of public URL - we'll generate signed URLs on demand
      return fileName;
    } catch (error) {
      console.error('Error in uploadResume:', error);
      throw error;
    }
  }

  // Generate a signed URL for accessing resumes (expires in 1 hour)
  async getResumeSignedUrl(resumePath: string): Promise<string> {
    try {
      // If the path is already a full URL (legacy), return it as-is
      if (resumePath.startsWith('http://') || resumePath.startsWith('https://')) {
        return resumePath;
      }

      const { data, error } = await supabaseAdmin.storage
        .from('resumes')
        .createSignedUrl(resumePath, 3600); // 1 hour expiry

      if (error) {
        console.error('Error creating signed URL:', error);
        throw new Error('Failed to generate resume URL.');
      }

      return data.signedUrl;
    } catch (error) {
      console.error('Error in getResumeSignedUrl:', error);
      throw error;
    }
  }

  async updateUserInfo(userId: string, userData: Partial<UpsertUser>): Promise<any> {
    try {
      const [user] = await db
        .update(users)
        .set({ ...userData, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning();
      return user;
    } catch (error) {
      console.error('Error updating user profile:', error);
      throw error;
    }
  }

  // Candidate operations
  async getCandidateUser(userId: string): Promise<CandidateProfile | undefined> {
    try {
      console.log(`[storage] Getting candidate profile for user id: ${userId}`);
      const [profile] = await db
        .select()
        .from(candidateProfiles)
        .where(eq(candidateProfiles.userId, userId));
      console.log(`[storage] Found candidate profile:`, profile);
      return profile;
    } catch (error) {
      console.error('Error fetching candidate profile:', error);
      throw error;
    }
  }

  async upsertCandidateUser(profile: InsertCandidateProfile): Promise<CandidateProfile> {
    try {
      const normalizedSkills = profile.skills ? normalizeSkills(profile.skills) : [];
      const [result] = await db
        .insert(candidateProfiles)
        .values({
          ...profile,
          skills: normalizedSkills,
          updatedAt: new Date()
        } as any)
        .onConflictDoUpdate({
          target: candidateProfiles.userId,
          set: {
            ...profile,
            ...(profile.skills !== undefined && { skills: normalizedSkills }),
            updatedAt: new Date(),
          },
        })
        .returning();
      return result;
    } catch (error) {
      console.error('Error upserting candidate profile:', error);
      throw error;
    }
  }

  async getAllCandidateUsers(): Promise<CandidateProfile[]> {
    try {
      return await db.select().from(candidateProfiles);
    } catch (error) {
      console.error('Error fetching all candidate profiles:', error);
      throw error;
    }
  }

  async getCandidatesForParseRetry(limit: number): Promise<CandidateProfile[]> {
    try {
      return await db.select().from(candidateProfiles)
        .where(
          and(
            eq(candidateProfiles.resumeProcessingStatus, 'failed'),
            sql`${candidateProfiles.resumeUrl} IS NOT NULL`,
            sql`(${candidateProfiles.parseAttempts} < 3 OR ${candidateProfiles.parseAttempts} IS NULL)`
          )
        )
        .limit(limit);
    } catch (error) {
      console.error('Error fetching candidates for parse retry:', error);
      throw error;
    }
  }

  async incrementParseAttempts(userId: string): Promise<void> {
    try {
      await db.update(candidateProfiles)
        .set({ parseAttempts: sql`COALESCE(${candidateProfiles.parseAttempts}, 0) + 1` })
        .where(eq(candidateProfiles.userId, userId));
    } catch (error) {
      console.error('Error incrementing parse attempts:', error);
      throw error;
    }
  }

  // Talent Owner operations
  async getTalentOwnerProfile(userId: string): Promise<TalentOwnerProfile | undefined> {
    try {
      const [profile] = await db
        .select()
        .from(talentOwnerProfiles)
        .where(eq(talentOwnerProfiles.userId, userId));
      return profile;
    } catch (error) {
      console.error('Error fetching talent owner profile:', error);
      throw error;
    }
  }

  async upsertTalentOwnerProfile(profile: InsertTalentOwnerProfile): Promise<TalentOwnerProfile> {
    try {
      const [result] = await db
        .insert(talentOwnerProfiles)
        .values({
          ...profile,
          updatedAt: new Date()
        })
        .onConflictDoUpdate({
          target: talentOwnerProfiles.userId,
          set: {
            ...profile,
            updatedAt: new Date(),
          },
        })
        .returning();
      return result;
    } catch (error) {
      console.error('Error upserting talent owner profile:', error);
      throw error;
    }
  }


  async saveJob(userId: string, jobId: number): Promise<void> {
    try {
      await db.insert(savedJobs).values({ userId, jobId }).onConflictDoNothing();
    } catch (error) {
      console.error('Error saving job:', error);
      throw error;
    }
  }

  async unsaveJob(userId: string, jobId: number): Promise<void> {
    try {
      await db.delete(savedJobs).where(and(eq(savedJobs.userId, userId), eq(savedJobs.jobId, jobId)));
    } catch (error) {
      console.error('Error unsaving job:', error);
      throw error;
    }
  }

  async hideJob(userId: string, jobId: number): Promise<void> {
    try {
      await db.insert(hiddenJobs).values({ userId, jobId }).onConflictDoNothing();
    } catch (error) {
      console.error('Error hiding job:', error);
      throw error;
    }
  }

  async getSavedJobIds(userId: string): Promise<number[]> {
    try {
      const results = await db.select({ jobId: savedJobs.jobId }).from(savedJobs).where(eq(savedJobs.userId, userId));
      return results.map(r => r.jobId);
    } catch (error) {
      console.error('Error getting saved job ids:', error);
      throw error;
    }
  }

  async getHiddenJobIds(userId: string): Promise<number[]> {
    try {
      const results = await db.select({ jobId: hiddenJobs.jobId }).from(hiddenJobs).where(eq(hiddenJobs.userId, userId));
      return results.map(r => r.jobId);
    } catch (error) {
      console.error('Error getting hidden job ids:', error);
      throw error;
    }
  }



  // Job operations
  async createJobPosting(job: InsertJobPosting): Promise<JobPosting> {
    try {
      const [result] = await db.insert(jobPostings).values({
        ...job,
        skills: normalizeSkills(job.skills || []),
        requirements: job.requirements || [],
        hiringManagerId: job.hiringManagerId || job.talentOwnerId, // Default to talent owner if no hiring manager specified
      }).returning();
      return result;
    } catch (error) {
      console.error('Error creating job posting:', error);
      throw error;
    }
  }

  async getJobPostings(talentOwnerId: string): Promise<JobPosting[]> {
    try {
      if (!talentOwnerId) {
        // This case should ideally not be reached if endpoints are secure
        console.warn('[storage] getJobPostings called without a talentOwnerId.');
        return [];
      }

      return await db
        .select()
        .from(jobPostings)
        .where(eq(jobPostings.talentOwnerId, talentOwnerId))
        .orderBy(desc(jobPostings.createdAt));
    } catch (error) {
      console.error('Error fetching job postings:', error);
      throw error;
    }
  }

  async getJobPosting(id: number): Promise<JobPosting | undefined> {
    try {
      const [job] = await db.select().from(jobPostings).where(eq(jobPostings.id, id));
      return job;
    } catch (error) {
      console.error('Error fetching job posting:', error);
      throw error;
    }
  }

  async getExternalJobs(skills: string[] = [], filters: { jobTitle?: string; location?: string; workType?: string } = {}): Promise<JobPosting[]> {
    try {
      console.log('[storage] Fetching external jobs', skills.length > 0 ? `with skills: ${skills.join(', ')}` : '', filters.jobTitle ? `title: ${filters.jobTitle}` : '');

      // Only show jobs from last 90 days for fresh results (reduced from unlimited, will tighten to 30 once scraper is stable)
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const cutoffDateStr = ninetyDaysAgo.toISOString();

      const conditions = [
        eq(jobPostings.status, 'active'),
        or(
          sql`${jobPostings.source} = 'external'`,
          sql`${jobPostings.externalUrl} IS NOT NULL`
        ),
        // Exclude all aggregator sources — links don't go to actual job post pages
        sql`${jobPostings.source} NOT IN (${sql.join(
          [...AGGREGATOR_SOURCES].map(s => sql`${s}`), sql`, `
        )})`,
        // Exclude any external_url that still routes through an aggregator
        aggregatorUrlExclusion,
        // Require URL to point to a real job post page (platform jobs exempt — no external_url)
        or(
          eq(jobPostings.source, 'platform'),
          jobPostUrlRequirement
        ),
        or(
          sql`${jobPostings.expiresAt} IS NULL`,
          sql`${jobPostings.expiresAt} > NOW()`
        ),
        // Only recent jobs - last 90 days
        sql`${jobPostings.createdAt} > ${cutoffDateStr}`
      ];

      // Filter by job title: split into tokens and require ALL to appear in title.
      // e.g. "Python Developer" → LIKE '%python%' AND LIKE '%developer%'
      // so "Senior Fullstack Developer (Python)" is matched even though the exact
      // phrase "Python Developer" doesn't appear verbatim.
      if (filters.jobTitle?.trim()) {
        const words = filters.jobTitle.trim().split(/\s+/).filter(w => w.length > 0);
        if (words.length === 1) {
          conditions.push(sql`LOWER(${jobPostings.title}) LIKE LOWER(${'%' + words[0] + '%'})`);
        } else {
          const wordConditions = words.map(word =>
            sql`LOWER(${jobPostings.title}) LIKE LOWER(${'%' + word + '%'})`
          );
          conditions.push(and(...wordConditions)!);
        }
      }

      // Filter by work type
      if (filters.workType?.trim() && filters.workType !== 'any') {
        conditions.push(eq(jobPostings.workType, filters.workType));
      }

      // Location SQL filter: when user specifies a city/region, fetch jobs in that location
      // OR remote jobs (remote is always relevant regardless of location).
      // This ensures the 200-row pool isn't exclusively remote jobs when a city is searched.
      if (filters.location?.trim()) {
        const locPattern = '%' + filters.location.trim() + '%';
        conditions.push(
          or(
            sql`LOWER(${jobPostings.location}) LIKE LOWER(${locPattern})`,
            sql`LOWER(${jobPostings.location}) LIKE '%remote%'`,
            sql`${jobPostings.location} IS NULL`,
            sql`${jobPostings.location} = ''`
          )
        );
      }

      // Skills filter pushed to SQL: match title OR any element in the JSON skills array.
      // skills is a jsonb column → cast to text for a fast LIKE without needing GIN index.
      if (skills.length > 0) {
        const skillConditions = skills.map(skill =>
          or(
            sql`LOWER(${jobPostings.title}) LIKE LOWER(${'%' + skill + '%'})`,
            sql`LOWER(${jobPostings.skills}::text) LIKE LOWER(${'%' + skill + '%'})`
          )
        );
        conditions.push(or(...skillConditions)!);
      }

      // Query external jobs (source = 'external' or externalUrl is set)
      const query = db
        .select()
        .from(jobPostings)
        .where(and(...conditions))
        .orderBy(usPriorityOrder, sql`${jobPostings.createdAt} DESC`)
        .limit(150);

      const jobs = await query;

      // Note: non-US jobs are ranked last via usPriorityOrder rather than dropped,
      // so the user always sees a feed even when most rows are international.
      let filteredJobs = jobs;

      // Additional location filter from user input
      if (filters.location?.trim()) {
        const loc = filters.location.trim().toLowerCase();
        const searchingRemote = loc.includes('remote');
        filteredJobs = filteredJobs.filter((job: any) => {
          const jobLoc = (job.location || '').toLowerCase();
          // Remote jobs are always shown — they're accessible from any location
          if (!searchingRemote && (jobLoc.includes('remote') || jobLoc === '')) return true;
          // For remote searches, only return remote/no-location jobs
          if (searchingRemote) return jobLoc.includes('remote') || jobLoc === '';
          // City/region match
          return jobLoc.includes(loc);
        });
      }

      console.log(`[storage] Returning ${filteredJobs.length} recent US external jobs (filtered from ${jobs.length})`);
      return filteredJobs;
    } catch (error) {
      console.error('Error fetching external jobs:', error);
      throw error;
    }
  }

  // Empty-state fallback: aggregator-sourced jobs (Adzuna, JSearch, Indeed, etc.)
  // surfaced ONLY when the main feed returns zero matches. Caller must badge these
  // clearly as leaving the platform — the URL points to the aggregator, not the employer.
  async getAggregatorFallbackJobs(
    skills: string[] = [],
    filters: { jobTitle?: string; location?: string; workType?: string } = {},
    limit: number = 10
  ): Promise<JobPosting[]> {
    try {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const cutoffDateStr = ninetyDaysAgo.toISOString();

      // Rank by how many of the candidate's skills actually match, then by recency.
      const skillMatchExpr = skills.length > 0
        ? sql`(${sql.join(
            skills.map(skill =>
              sql`(CASE WHEN LOWER(${jobPostings.title}) LIKE LOWER(${'%' + skill + '%'}) OR LOWER(${jobPostings.skills}::text) LIKE LOWER(${'%' + skill + '%'}) THEN 1 ELSE 0 END)`
            ),
            sql` + `
          )})`
        : sql`0`;

      const baseConditions = (): any[] => [
        eq(jobPostings.status, 'active'),
        sql`${jobPostings.source} IN (${sql.join(
          [...AGGREGATOR_SOURCES].map(s => sql`${s}`), sql`, `
        )})`,
        sql`${jobPostings.externalUrl} IS NOT NULL`,
        or(
          sql`${jobPostings.expiresAt} IS NULL`,
          sql`${jobPostings.expiresAt} > NOW()`
        ),
        sql`${jobPostings.createdAt} > ${cutoffDateStr}`,
      ];

      const titleCondition = (() => {
        if (!filters.jobTitle?.trim()) return null;
        const words = filters.jobTitle.trim().split(/\s+/).filter(w => w.length > 0);
        const wordConditions = words.map(word =>
          sql`LOWER(${jobPostings.title}) LIKE LOWER(${'%' + word + '%'})`
        );
        return words.length === 1 ? wordConditions[0] : and(...wordConditions)!;
      })();

      const workTypeCondition = filters.workType?.trim() && filters.workType !== 'any'
        ? eq(jobPostings.workType, filters.workType)
        : null;

      // Match on the city portion only ("Seattle, WA" → "%seattle%") so stored
      // locations like "Seattle, WA, USA" or "Seattle Metro Area" still match.
      // Falls back to remote roles regardless.
      const locationCondition = (() => {
        const raw = filters.location?.trim();
        if (!raw) return null;
        const city = raw.split(',')[0].trim();
        const pattern = '%' + (city || raw) + '%';
        return or(
          sql`LOWER(${jobPostings.location}) LIKE LOWER(${pattern})`,
          sql`LOWER(${jobPostings.location}) LIKE '%remote%'`,
        );
      })();

      const skillCondition = skills.length > 0
        ? or(...skills.map(skill =>
            or(
              sql`LOWER(${jobPostings.title}) LIKE LOWER(${'%' + skill + '%'})`,
              sql`LOWER(${jobPostings.skills}::text) LIKE LOWER(${'%' + skill + '%'})`
            )
          ))!
        : null;

      const runQuery = async (extras: (any | null)[]) => {
        const conditions = [...baseConditions(), ...extras.filter(Boolean)];
        return db
          .select()
          .from(jobPostings)
          .where(and(...conditions))
          .orderBy(sql`${skillMatchExpr} DESC, ${jobPostings.createdAt} DESC`)
          .limit(limit);
      };

      // Strict pass: location + skill + title + workType.
      let jobs = await runQuery([titleCondition, workTypeCondition, locationCondition, skillCondition]);

      // If location starved the pool, retry without location so remote-anywhere
      // candidates in low-coverage cities still see relevant aggregator results.
      if (jobs.length === 0 && locationCondition) {
        jobs = await runQuery([titleCondition, workTypeCondition, skillCondition]);
      }

      return jobs;
    } catch (error) {
      console.error('Error fetching aggregator fallback jobs:', error);
      return [];
    }
  }

  async getJobStatistics(): Promise<any> {
    try {
      const { sql } = await import('drizzle-orm/sql');
      const { count } = await import('drizzle-orm/sql/functions');

      // Total jobs
      const totalJobs = await db
        .select({ count: sql`COUNT(*)::int` })
        .from(jobPostings);

      // Jobs by source
      const jobsBySource = await db
        .select({
          source: jobPostings.source,
          count: sql`COUNT(*)::int`
        })
        .from(jobPostings)
        .groupBy(jobPostings.source);

      // Jobs by status
      const jobsByStatus = await db
        .select({
          status: jobPostings.status,
          count: sql`COUNT(*)::int`
        })
        .from(jobPostings)
        .groupBy(jobPostings.status);

      // External jobs specifically
      const externalJobs = await db
        .select({ count: sql`COUNT(*)::int` })
        .from(jobPostings)
        .where(sql`${jobPostings.externalUrl} IS NOT NULL OR ${jobPostings.source} != 'platform'`);

      return {
        totalJobs: (totalJobs[0] as any)?.count || 0,
        externalJobs: (externalJobs[0] as any)?.count || 0,
        jobsBySource: jobsBySource.map((j: any) => ({
          source: j.source || 'unknown',
          count: j.count
        })),
        jobsByStatus: jobsByStatus.map((j: any) => ({
          status: j.status,
          count: j.count
        })),
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error getting job statistics:', error);
      throw error;
    }
  }

  /**
   * Fetch and score jobs for a candidate. Shared logic for both flat and sectioned responses.
   */
  // Discovery feed — fallback shown when we have no usable skill signal to score
  // against. Returns recent, trusted, platform-first jobs with matchScore=0 and
  // a 'discovery' tier so the UI can render them as "browse" rows rather than
  // ranked matches. Called by fetchScoredJobs in two empty-signal cases.
  private async getDiscoveryFeed(
    excludeIds: number[],
    explanation: string,
    relevance?: { skills?: string[]; roleKeywords?: string[] },
  ): Promise<any[]> {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const cutoffDateStr = ninetyDaysAgo.toISOString();

    // Shared trusted-ATS query; `extraWhere` adds a relevance filter and
    // `relevanceOrder` lets us rank the most on-target rows (role-title matches)
    // ahead of the generic US/trust/recency ordering.
    const runQuery = (extraWhere: any[], relevanceOrder: any[] = []) => db
      .select()
      .from(jobPostings)
      .where(and(
        eq(jobPostings.status, 'active'),
        or(
          sql`${jobPostings.expiresAt} IS NULL`,
          sql`${jobPostings.expiresAt} > NOW()`
        ),
        // Platform jobs are verified by definition — skip liveness check
        or(
          eq(jobPostings.livenessStatus, 'active'),
          eq(jobPostings.livenessStatus, 'unknown'),
          eq(jobPostings.source, 'platform')
        ),
        // Platform jobs are never ghost jobs
        or(
          sql`${jobPostings.ghostJobScore} IS NULL`,
          sql`${jobPostings.ghostJobScore} < 60`,
          eq(jobPostings.source, 'platform')
        ),
        // Platform jobs are exempt from the 90-day cutoff
        or(
          eq(jobPostings.source, 'platform'),
          sql`${jobPostings.createdAt} > ${cutoffDateStr}`
        ),
        // Exclude all aggregator sources
        sql`${jobPostings.source} NOT IN (${sql.join(
          [...AGGREGATOR_SOURCES].map(s => sql`${s}`), sql`, `
        )})`,
        aggregatorUrlExclusion,
        // Require URL to point to a real job post page (platform jobs exempt — no external_url)
        or(
          eq(jobPostings.source, 'platform'),
          jobPostUrlRequirement
        ),
        // Exclude hidden and applied-to jobs
        ...(excludeIds.length > 0
          ? [sql`${jobPostings.id} NOT IN (${sql.join(excludeIds.map(id => sql`${id}`), sql`, `)})`]
          : []),
        ...extraWhere,
      ))
      .orderBy(
        ...relevanceOrder,
        // Rank: platform first, then US, then unknown, then non-US
        usPriorityOrder,
        sql`${jobPostings.trustScore} DESC NULLS LAST`,
        sql`${jobPostings.createdAt} DESC`
      )
      .limit(20);

    // Relevant-first: prefer ATS jobs whose TITLE matches the candidate's role
    // keywords (e.g. "it support", "site reliability" — the strongest relevance
    // signal) or whose skills overlap theirs (GIN-indexed ?|). Rank title matches
    // ahead of skill-only matches so an IT-support candidate doesn't lead with
    // sales/finance roles that merely share soft skills. Fall through to the
    // generic recent-roles query when there's no relevant supply, so we never
    // return empty (empty → the client drops to the external aggregator fallback).
    const relevantSkills = (relevance?.skills || []).filter(s => s && s.length > 0);
    const roleKeywords = (relevance?.roleKeywords || []).filter(k => k && k.length >= 3);
    const titleMatch = roleKeywords.length > 0
      ? or(...roleKeywords.map(k => sql`${jobPostings.title} ~* ${'\\y' + escapePgRegex(k) + '\\y'}`))
      : undefined;
    const skillMatch = relevantSkills.length > 0
      ? sql`${jobPostings.skills} ?| ARRAY[${sql.join(relevantSkills.map(s => sql`${s}`), sql`, `)}]::text[]`
      : undefined;
    const relevanceWhere = [titleMatch, skillMatch].filter(Boolean) as any[];

    let discoveryJobs: any[] = [];
    if (relevanceWhere.length > 0) {
      // Title matches sort first (0), skill-only matches after (1).
      const relevanceOrder = titleMatch
        ? [sql`CASE WHEN ${titleMatch} THEN 0 ELSE 1 END`]
        : [];
      discoveryJobs = await runQuery(
        [relevanceWhere.length > 1 ? or(...relevanceWhere) : relevanceWhere[0]],
        relevanceOrder,
      );
    }
    if (discoveryJobs.length === 0) {
      discoveryJobs = await runQuery([]);
    }

    return discoveryJobs.map((job: any) => {
      const { freshness, daysOld } = getFreshnessLabel(job.createdAt);
      return {
        ...job,
        requirements: Array.isArray(job.requirements) ? job.requirements : [],
        skills: Array.isArray(job.skills) ? job.skills : [],
        matchScore: 0,
        matchTier: 'discovery' as const,
        skillMatches: [],
        aiExplanation: explanation,
        isVerifiedActive: job.livenessStatus === 'active' && (job.trustScore || 0) >= 90,
        isDirectFromCompany: isFromAts(job.source),
        freshness,
        daysOld,
        ghostJobScore: job.ghostJobScore || 0,
        ghostJobStatus: job.ghostJobStatus || 'clean',
        ghostJobReasons: job.ghostJobReasons || [],
        companyVerified: job.companyVerified || false,
      };
    });
  }

  private async fetchScoredJobs(candidateId: string, filters?: { jobTitle?: string; location?: string; workType?: string }): Promise<any[] | null> {
    const candidate = await this.getCandidateUser(candidateId);

    // Fetch hidden + applied job IDs to exclude from all recommendation paths
    const [hiddenIds, appliedIds] = await Promise.all([
      this.getHiddenJobIds(candidateId),
      db.select({ jobId: jobApplications.jobId })
        .from(jobApplications)
        .where(eq(jobApplications.candidateId, candidateId))
        .then(rows => rows.map(r => r.jobId)),
    ]);
    const excludeIds = [...new Set([...hiddenIds, ...appliedIds])];

    if (!candidate || !candidate.skills || candidate.skills.length === 0) {
      console.log(`Candidate ${candidateId} has no skills - returning discovery feed`);
      return this.getDiscoveryFeed(excludeIds, 'Upload your resume to get personalized matches');
    }

    const jobPreferences = (candidate as any)?.jobPreferences || {};
    const candidateSkills = parseSkillsInput(candidate.skills);
    console.log(`Candidate skills (normalized): ${candidateSkills.join(', ')}`);

    // Raw skills exist but none matched our skill catalog — fall through to the
    // discovery feed rather than returning null (which the caller treats as no
    // results). This prevents candidates whose resumes parsed to non-normalizable
    // tokens from seeing "No matches yet" despite having uploaded a resume.
    if (candidateSkills.length === 0) {
      console.log(`Candidate ${candidateId} has skills but none normalized - returning discovery feed`);
      return this.getDiscoveryFeed(excludeIds, "We couldn't recognize specific skills from your resume — here are recent roles to explore");
    }

    // Extract candidate's previous job titles from resume parsing data
    const candidateTitles: string[] = [];
    const parsingData = (candidate as any).resumeParsingData;
    if (parsingData?.positions && Array.isArray(parsingData.positions)) {
      for (const pos of parsingData.positions) {
        if (pos.title && typeof pos.title === 'string' && pos.title.trim().length > 2) {
          candidateTitles.push(pos.title.trim());
        }
      }
    }
    if (candidateTitles.length > 0) {
      console.log(`Candidate titles: ${candidateTitles.join(', ')}`);
    }

    // Parse pre-computed candidate embedding for semantic scoring (sync — no API call)
    let candidateEmbedding: number[] | undefined;
    if ((candidate as any).vectorEmbedding) {
      try {
        candidateEmbedding = JSON.parse((candidate as any).vectorEmbedding);
      } catch { /* malformed — skip semantic scoring */ }
    }

    // Only show jobs from last 90 days for fresh results
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const cutoffDateStr = ninetyDaysAgo.toISOString();

    // Build optional filter conditions from the search UI
    const extraFilters: any[] = [];
    if (filters?.jobTitle) {
      extraFilters.push(sql`LOWER(${jobPostings.title}) LIKE ${'%' + filters.jobTitle.toLowerCase() + '%'}`);
    }
    if (filters?.location) {
      // Don't punish IT candidates: searching "Seattle" should still surface
      // remote and location-less roles, which make up most of the tech pool.
      const pat = '%' + filters.location.toLowerCase() + '%';
      extraFilters.push(or(
        sql`LOWER(${jobPostings.location}) LIKE ${pat}`,
        sql`LOWER(${jobPostings.location}) LIKE '%remote%'`,
        sql`LOWER(${jobPostings.workType}) = 'remote'`,
        sql`${jobPostings.location} IS NULL`,
        sql`${jobPostings.location} = ''`
      ));
    }
    if (filters?.workType) {
      extraFilters.push(sql`LOWER(${jobPostings.workType}) = ${filters.workType.toLowerCase()}`);
    }

    // ── Retrieval: pgvector ANN + keyword hybrid ──────────────────
    // When candidate has an embedding, use pgvector cosine distance to find
    // semantically similar jobs (top 200) and merge with keyword matches (top 100).
    // This ensures semantic matches surface even when keywords don't overlap.

    const titleMatchSkills = candidateSkills.filter(s => s.length >= 4);
    const roleTitleKeywords = getRoleTitleKeywords(candidateTitles);
    if (roleTitleKeywords.length > 0) {
      console.log(`Role title keywords: ${roleTitleKeywords.join(', ')}`);
    }

    // Shared filters for both retrieval paths
    const baseFilters = and(
      eq(jobPostings.status, 'active'),
      or(
        sql`${jobPostings.expiresAt} IS NULL`,
        sql`${jobPostings.expiresAt} > NOW()`
      ),
      or(
        eq(jobPostings.livenessStatus, 'active'),
        eq(jobPostings.livenessStatus, 'unknown'),
        eq(jobPostings.source, 'platform')
      ),
      or(
        sql`${jobPostings.ghostJobScore} IS NULL`,
        sql`${jobPostings.ghostJobScore} < 60`,
        eq(jobPostings.source, 'platform')
      ),
      or(
        eq(jobPostings.source, 'platform'),
        sql`${jobPostings.createdAt} > ${cutoffDateStr}`
      ),
      sql`${jobPostings.source} NOT IN (${sql.join(
        [...AGGREGATOR_SOURCES].map(s => sql`${s}`), sql`, `
      )})`,
      aggregatorUrlExclusion,
      // Require URL to point to a real job post page (platform jobs exempt — no external_url)
      or(
        eq(jobPostings.source, 'platform'),
        jobPostUrlRequirement
      ),
      // Hard non-US exclusion. Empty/null/Remote stay in (they could be US);
      // only rows whose location explicitly matches the non-US regex are dropped.
      // The "new mexico" replace prevents the bare-"mexico" check from flagging
      // the US state.
      or(
        eq(jobPostings.source, 'platform'),
        sql`${jobPostings.location} IS NULL`,
        sql`TRIM(${jobPostings.location}) = ''`,
        and(
          sql`NOT (${jobPostings.location} ~* ${NON_US_LOCATION_REGEX})`,
          sql`NOT (regexp_replace(LOWER(${jobPostings.location}), 'new mexico', '', 'g') ~* ${MEXICO_COUNTRY_REGEX})`,
          sql`NOT (${jobPostings.location} ~* ${', ?(' + CA_PROVINCE_CODES_RE_PART + ')( |,|$)'})`,
        ),
      ),
      ...(excludeIds.length > 0
        ? [sql`${jobPostings.id} NOT IN (${sql.join(excludeIds.map(id => sql`${id}`), sql`, `)})`]
        : []),
      ...extraFilters,
    );

    let allJobs: any[];
    let vectorDistMap = new Map<number, number>();

    // Hydrate projection that omits the two heavy embedding columns
    // (vector_embedding text + embedding vector). Neither is needed downstream:
    // Path A precomputes cosine distance in SQL; Path B has no candidate
    // embedding so scoreJob never reads them. Skipping them is what keeps the
    // hydrate fast (SELECT * over ~1000 rows ships ~8MB of embedding data).
    const { embedding: _omitEmbedding, vectorEmbedding: _omitVectorEmbedding, ...slimColumns } = getTableColumns(jobPostings);

    if (candidateEmbedding && candidateEmbedding.length > 0 && client) {
      // ── Path A: pgvector semantic retrieval + keyword backup ──
      const vectorStr = `[${candidateEmbedding.join(',')}]`;
      console.time('pgvector-query');

      // pgvector ANN retrieval — top 100 by cosine distance
      // Return cosine_dist so scoreJob can use pre-computed similarity (avoids JSON.parse of 8KB text per row)
      const aggregatorList = [...AGGREGATOR_SOURCES].map(s => `'${s}'`).join(', ');
      const aggregatorUrlList = AGGREGATOR_URL_PATTERNS.map(p => `external_url ILIKE '%${p}%'`).join(' OR ');
      // Mirror of jobPostUrlRequirement — must stay in sync with the drizzle fragment above.
      const jobPostUrlRequirementSql = `(
        source = 'platform' OR (
          external_url IS NOT NULL
          AND NOT (external_url ~ '^https?://[^/]+/?$')
          AND (
            external_url ~ '[/?][^/?#]*\\d{4,}'
            OR external_url ~* '(gh_jid|jobid|requisition|posting|/job/|/jobs/[a-z0-9_-]{8,})'
            OR external_url ~* '(boards\\.greenhouse\\.io|job-boards\\.greenhouse\\.io|jobs\\.lever\\.co|jobs\\.ashbyhq\\.com|\\.recruitee\\.com|\\.workable\\.com|\\.bamboohr\\.com|myworkdayjobs\\.com|smartrecruiters\\.com|icims\\.com|taleo\\.net)'
          )
        )
      )`;

      // Build the query via client.unsafe() with explicit $-parameter binding.
      // The previous implementation embedded drizzle's sql.raw() fragments into
      // a postgres-js template tag; the two libraries don't share a protocol,
      // so the fragments serialized to "[object Object]" and silently coerced
      // every WHERE clause to FALSE — zeroing out the entire pgvector path.
      const caProvinceSuffix = `, ?(${CA_PROVINCE_CODES_RE_PART})( |,|$)`;
      const params: any[] = [vectorStr, cutoffDateStr, NON_US_LOCATION_REGEX, MEXICO_COUNTRY_REGEX, caProvinceSuffix];
      let conditionals = '';
      if (excludeIds.length > 0) {
        params.push(excludeIds);
        conditionals += ` AND id != ALL($${params.length}::int[])`;
      }
      if (filters?.jobTitle) {
        params.push('%' + filters.jobTitle.toLowerCase() + '%');
        conditionals += ` AND LOWER(title) LIKE $${params.length}`;
      }
      if (filters?.location) {
        params.push('%' + filters.location.toLowerCase() + '%');
        conditionals += ` AND LOWER(location) LIKE $${params.length}`;
      }
      if (filters?.workType) {
        params.push(filters.workType.toLowerCase());
        conditionals += ` AND LOWER(work_type) = $${params.length}`;
      }

      const rawQuery = `
        SELECT id, (embedding <=> $1::vector) AS cosine_dist FROM job_postings
        WHERE status = 'active'
          AND embedding IS NOT NULL
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (liveness_status IN ('active', 'unknown') OR source = 'platform')
          AND (ghost_job_score IS NULL OR ghost_job_score < 60 OR source = 'platform')
          AND (source = 'platform' OR created_at > $2)
          AND source NOT IN (${aggregatorList})
          AND (external_url IS NULL OR NOT (${aggregatorUrlList}))
          AND ${jobPostUrlRequirementSql}
          AND (
            source = 'platform'
            OR location IS NULL
            OR TRIM(location) = ''
            OR (
              NOT (location ~* $3)
              AND NOT (regexp_replace(LOWER(location), 'new mexico', '', 'g') ~* $4)
              AND NOT (location ~* $5)
            )
          )
          ${conditionals}
        ORDER BY embedding <=> $1::vector
        LIMIT 100
      `;

      // SET LOCAL must run inside a transaction — wrap both statements so
      // they share a single backend connection through pgBouncer's
      // transaction pooler. Default hnsw.ef_search=40 returns only ~13-40
      // candidates for embeddings in sparse regions of the HNSW graph;
      // bumping to 200 reliably surfaces the top-100 nearest.
      const vectorRows = await client.begin(async (tx: any) => {
        await tx.unsafe('SET LOCAL hnsw.ef_search = 200');
        return tx.unsafe(rawQuery, params);
      });
      console.timeEnd('pgvector-query');
      // Map job id → pre-computed cosine distance (0=identical, 2=opposite)
      for (const r of vectorRows) vectorDistMap.set(r.id, parseFloat(r.cosine_dist));
      const vectorIds = new Set(vectorDistMap.keys());
      console.log(`[pgvector] Retrieved ${vectorIds.size} jobs by semantic similarity`);

      // Keyword retrieval — top 100 (existing logic)
      console.time('keyword-query');
      const keywordJobs = await db
        .select({ id: jobPostings.id })
        .from(jobPostings)
        .where(and(
          baseFilters,
          or(
            // GIN-indexed skill match (idx_job_postings_skills_gin via the ?|
            // operator). candidateSkills and stored job skills both pass through
            // normalizeSkill(), so they share canonical case — no LOWER() needed,
            // which is what lets ?| use the index. Replaces a per-row
            // jsonb_array_elements_text subplan per skill (~7.7s → ~50ms).
            sql`${jobPostings.skills} ?| ARRAY[${sql.join(candidateSkills.map(s => sql`${s}`), sql`, `)}]::text[]`,
            // ILIKE (not ~* word-boundary regex) so these use the pg_trgm GIN
            // index on title. The regex form can't use the index → a seq scan
            // that cost ~40s alone; ILIKE substring match is ~26-85x faster and
            // the scorer re-ranks on precise title relevance anyway.
            ...(titleMatchSkills.length > 0
              ? titleMatchSkills.map(skill =>
                  sql`${jobPostings.title} ILIKE ${'%' + escapeLike(skill) + '%'}`
                )
              : []),
            ...(roleTitleKeywords.length > 0
              ? roleTitleKeywords.map(keyword =>
                  sql`${jobPostings.title} ILIKE ${'%' + escapeLike(keyword) + '%'}`
                )
              : []),
            ...((titleMatchSkills.length === 0 && roleTitleKeywords.length === 0) ? [sql`FALSE`] : []),
          ),
        ))
        .limit(1000);
      console.timeEnd('keyword-query');
      const keywordIds = keywordJobs.map((r: any) => r.id);
      console.log(`[keyword] Retrieved ${keywordIds.length} jobs by keyword match`);

      // Merge and deduplicate
      const mergedIds = [...new Set([...vectorIds, ...keywordIds.map(Number)])];
      console.log(`[hybrid] Merged ${mergedIds.length} unique jobs for scoring`);

      if (mergedIds.length === 0) {
        allJobs = [];
      } else {
        // Cosine distance for ALL merged ids in one query (~0.3s). The ANN query
        // only returned distances for its own top-100; computing the rest here
        // lets scoreJob use a precomputed distance for every job, so it never
        // JSON.parses the per-row vector_embedding text — which in turn lets the
        // hydrate skip the two embedding columns entirely (see below).
        console.time('dist-query');
        const distRows = await client.unsafe(
          `SELECT id, (embedding <=> $1::vector) AS d FROM job_postings WHERE id = ANY($2::int[]) AND embedding IS NOT NULL`,
          [vectorStr, mergedIds],
        );
        for (const r of distRows) vectorDistMap.set(Number(r.id), parseFloat(r.d));
        console.timeEnd('dist-query');

        // Slim hydrate (slimColumns omits the two heavy embedding columns). For a
        // ~1000-row merged set, SELECT * spends ~40s shipping/decoding ~8MB of
        // embedding data we no longer need (distances are precomputed above).
        // Dropping them takes the hydrate from ~40s → ~3s.
        console.time('hydrate-query');
        allJobs = await db
          .select(slimColumns)
          .from(jobPostings)
          .where(sql`${jobPostings.id} IN (${sql.join(mergedIds.map(id => sql`${id}`), sql`, `)})`)
          .orderBy(
            sql`CASE WHEN ${jobPostings.source} = 'platform' THEN 0 ELSE 1 END`,
            sql`${jobPostings.trustScore} DESC NULLS LAST`,
            sql`${jobPostings.createdAt} DESC`
          );
        console.timeEnd('hydrate-query');
      }
    } else {
      // ── Path B: keyword-only fallback (no embedding) ──
      console.time('keyword-only-query');
      allJobs = await db
        .select(slimColumns)
        .from(jobPostings)
        .where(and(
          baseFilters,
          or(
            // GIN-indexed skill match (idx_job_postings_skills_gin via the ?|
            // operator). candidateSkills and stored job skills both pass through
            // normalizeSkill(), so they share canonical case — no LOWER() needed,
            // which is what lets ?| use the index. Replaces a per-row
            // jsonb_array_elements_text subplan per skill (~7.7s → ~50ms).
            sql`${jobPostings.skills} ?| ARRAY[${sql.join(candidateSkills.map(s => sql`${s}`), sql`, `)}]::text[]`,
            // ILIKE (not ~* word-boundary regex) so these use the pg_trgm GIN
            // index on title. The regex form can't use the index → a seq scan
            // that cost ~40s alone; ILIKE substring match is ~26-85x faster and
            // the scorer re-ranks on precise title relevance anyway.
            ...(titleMatchSkills.length > 0
              ? titleMatchSkills.map(skill =>
                  sql`${jobPostings.title} ILIKE ${'%' + escapeLike(skill) + '%'}`
                )
              : []),
            ...(roleTitleKeywords.length > 0
              ? roleTitleKeywords.map(keyword =>
                  sql`${jobPostings.title} ILIKE ${'%' + escapeLike(keyword) + '%'}`
                )
              : []),
            ...((titleMatchSkills.length === 0 && roleTitleKeywords.length === 0) ? [sql`FALSE`] : []),
          ),
        ))
        .orderBy(
          sql`CASE WHEN ${jobPostings.source} = 'platform' THEN 0 ELSE 1 END`,
          sql`${jobPostings.trustScore} DESC NULLS LAST`,
          sql`${jobPostings.createdAt} DESC`
        )
        .limit(500);
      console.timeEnd('keyword-only-query');
    }

    const jobsWithSource = allJobs
      .map((job: any) => ({
        ...job,
        requirements: Array.isArray(job.requirements) ? job.requirements : [],
        skills: Array.isArray(job.skills) ? job.skills : []
      }));

    console.log(`Found ${jobsWithSource.length} matching jobs (internal + external, non-US filtered)`);

    console.time('score-jobs');
    const recommendations = jobsWithSource
      .map(job => {
        const score = scoreJob(candidateSkills, candidate.experienceLevel, job, candidateEmbedding, candidateTitles, {
          location: candidate.location,
          workType: candidate.workType,
        }, vectorDistMap.get(job.id));
        const { freshness, daysOld } = getFreshnessLabel(job.createdAt);

        return {
          ...job,
          matchScore: score.matchScore,
          matchTier: score.matchTier,
          skillMatches: score.skillMatches,
          partialSkillMatches: score.partialSkillMatches,
          aiExplanation: score.aiExplanation,
          scoreComponents: score.components,
          confidenceLevel: score.confidenceLevel,
          isVerifiedActive: job.livenessStatus === 'active' && (job.trustScore ?? 0) >= 90,
          isDirectFromCompany: isFromAts(job.source),
          freshness,
          daysOld,
          ghostJobScore: job.ghostJobScore || 0,
          ghostJobStatus: job.ghostJobStatus || 'clean',
          ghostJobReasons: job.ghostJobReasons || [],
          companyVerified: job.companyVerified || false,
        };
      });

      // ── Preference boost: soft signals, not hard filters ──────
      // Jobs matching preferences get a bonus; non-matching jobs are
      // demoted in rank but never eliminated. This ensures a user
      // always sees relevant jobs even when preferences are narrow.
      const WORK_TYPES = ['remote', 'hybrid', 'onsite'];
      let preferredWorkTypes: string[] = [];
      if (jobPreferences.workTypes && (jobPreferences.workTypes as string[]).length > 0) {
        preferredWorkTypes = (jobPreferences.workTypes as string[]).map((t: string) => t.toLowerCase());
      } else if (jobPreferences.companySizes && (jobPreferences.companySizes as string[]).length > 0) {
        preferredWorkTypes = (jobPreferences.companySizes as string[])
          .map((t: string) => t.toLowerCase())
          .filter((t: string) => WORK_TYPES.includes(t));
      }
      const preferredLevels = (jobPreferences.experienceLevels && jobPreferences.experienceLevels.length > 0)
        ? (jobPreferences.experienceLevels as string[]).map((l: string) => l.toLowerCase())
        : [];
      const preferredIndustries = (jobPreferences.industries && jobPreferences.industries.length > 0)
        ? jobPreferences.industries.map((i: string) => i.toLowerCase())
        : [];
      const prefMin = jobPreferences.salaryMin || 0;
      const prefMax = jobPreferences.salaryMax || 0;
      const salaryRangeValid = prefMax === 0 || prefMax >= prefMin;

      const LEVELS = ['entry', 'mid', 'senior', 'lead', 'executive'];

      const finalJobs = recommendations
        .filter(job => job.matchScore >= 30) // 30% minimum — prevents irrelevant jobs
        .map(job => {
          let prefBoost = 0;

          // Salary: +0.10 if in range, -0.05 if outside (many jobs lack salary data)
          if (salaryRangeValid && (prefMin || prefMax)) {
            const jobSalaryMin = job.salaryMin || 0;
            const jobSalaryMax = job.salaryMax || 0;
            if (jobSalaryMax === 0 && jobSalaryMin === 0) {
              // No salary data — neutral
            } else if ((!prefMin || jobSalaryMax >= prefMin) && (!prefMax || jobSalaryMin <= prefMax)) {
              prefBoost += 0.10;
            } else {
              prefBoost -= 0.05;
            }
          }

          // Work type: +0.10 if matches, -0.05 if not
          if (preferredWorkTypes.length > 0) {
            const jobWorkType = job.workType?.toLowerCase();
            if (!jobWorkType || preferredWorkTypes.includes(jobWorkType)) {
              prefBoost += 0.10;
            } else {
              prefBoost -= 0.05;
            }
          }

          // Experience level: +0.08 if matches, -0.03 if not
          if (preferredLevels.length > 0) {
            const inferred = LEVELS[inferJobLevel(job.title)];
            if (preferredLevels.includes(inferred)) {
              prefBoost += 0.08;
            } else {
              prefBoost -= 0.03;
            }
          }

          // Industry: +0.05 if matches, no penalty (too many jobs lack industry data)
          if (preferredIndustries.length > 0) {
            const jobIndustry = job.industry?.toLowerCase();
            if (jobIndustry && preferredIndustries.some((ind: string) => jobIndustry.includes(ind))) {
              prefBoost += 0.05;
            }
          }

          // Trust acts as a tie-breaker among good fits, never as a way to
          // lift a stretch role. Below TRUST_FIT_GATE the trust weight is
          // redistributed onto match so a high-trust off-role (e.g. a 30%
          // Stripe role for an IT-support candidate) can't out-rank a
          // high-fit non-direct row.
          const TRUST_FIT_GATE = 60;
          const goodFit = job.matchScore >= TRUST_FIT_GATE;
          const fit = job.matchScore / 100;
          const trust = (job.trustScore || 0) / 100;
          const recency = computeRecencyScore(job.createdAt);
          const compositeScore =
            (goodFit ? 0.70 : 0.85) * fit +
            (goodFit ? 0.15 * trust : 0) +
            0.10 * recency +
            prefBoost;

          return { ...job, prefBoost, compositeScore };
        })
        .sort((a, b) => {
          // Primary: US affinity (US first, then unknown, then non-US).
          const usA = jsUsLocationPriority(a);
          const usB = jsUsLocationPriority(b);
          if (usA !== usB) return usA - usB;
          return b.compositeScore - a.compositeScore;
        })
        .slice(0, 100); // Hard cap: never return more than 100 jobs
    console.timeEnd('score-jobs');

    // Score histogram so we can see whether the feed-floor filter is the cause
    // of empty results vs. retrieval pulling 0 candidates upstream.
    const scoreBuckets = { lt30: 0, b30_50: 0, b50_75: 0, gte75: 0 };
    for (const r of recommendations) {
      if (r.matchScore < 30) scoreBuckets.lt30++;
      else if (r.matchScore < 50) scoreBuckets.b30_50++;
      else if (r.matchScore < 75) scoreBuckets.b50_75++;
      else scoreBuckets.gte75++;
    }
    console.log(`[fetchScoredJobs] scored=${recommendations.length} buckets=<30:${scoreBuckets.lt30} 30-50:${scoreBuckets.b30_50} 50-75:${scoreBuckets.b50_75} 75+:${scoreBuckets.gte75} → after 30%+ filter: ${finalJobs.length}`);

    // A candidate WITH skills whose jobs all score below the 30% floor (common on
    // the keyword-only path before the embedding lands — see embedding quota issue)
    // would otherwise return [], which the feed reads as "zero matches" and drops
    // the candidate to the external aggregator fallback. Serve the ATS discovery
    // feed instead so a logged-in candidate never sees aggregators while we have
    // real platform/ATS supply to show.
    if (finalJobs.length === 0) {
      console.log(`[fetchScoredJobs] 0 jobs cleared the 30% floor — falling back to discovery feed`);
      return this.getDiscoveryFeed(excludeIds, 'Here are recent roles to explore while we tune your matches', { skills: candidateSkills, roleKeywords: roleTitleKeywords });
    }

    return finalJobs.map(({ prefBoost: _p, compositeScore: _c, ...job }) => job);
  }

  /**
   * Get job recommendations with server-side pagination.
   */
  async getJobRecommendations(
    candidateId: string,
    filters?: { jobTitle?: string; location?: string; workType?: string },
    pagination?: { page: number; limit: number },
  ): Promise<{ jobs: any[]; total: number; page: number; hasMore: boolean }> {
    try {
      const recommendations = await this.fetchScoredJobs(candidateId, filters);
      if (!recommendations || recommendations.length === 0) {
        return { jobs: [], total: 0, page: 1, hasMore: false };
      }

      const page = pagination?.page ?? 1;
      const limit = pagination?.limit ?? 20;
      const offset = (page - 1) * limit;
      const total = recommendations.length;
      const jobs = recommendations.slice(offset, offset + limit);

      console.log(`Returning page ${page}: ${jobs.length} of ${total} job recommendations`);
      return { jobs, total, page, hasMore: offset + limit < total };
    } catch (error) {
      console.error('Error fetching job recommendations:', error);
      throw error;
    }
  }

  /**
   * Skill-relevant ATS discovery feed for a single candidate. Lightweight (no
   * scoring, no full hybrid retrieval) so it stays fast even when full matching
   * is too slow to finish — the route serves this on a matching timeout so a
   * candidate with a profile sees relevant ATS roles instead of dropping to the
   * external aggregator fallback.
   */
  async getDiscoveryFeedForCandidate(candidateId: string): Promise<any[]> {
    const [candidate, hiddenIds, appliedIds] = await Promise.all([
      this.getCandidateUser(candidateId),
      this.getHiddenJobIds(candidateId),
      db.select({ jobId: jobApplications.jobId })
        .from(jobApplications)
        .where(eq(jobApplications.candidateId, candidateId))
        .then(rows => rows.map(r => r.jobId)),
    ]);
    const excludeIds = [...new Set([...hiddenIds, ...appliedIds])];
    const skills = candidate?.skills ? parseSkillsInput(candidate.skills) : [];

    // Role-title keywords from parsed resume positions are the strongest fast
    // relevance signal (e.g. "it support", "support engineer").
    const candidateTitles: string[] = [];
    const parsingData = (candidate as any)?.resumeParsingData;
    if (parsingData?.positions && Array.isArray(parsingData.positions)) {
      for (const pos of parsingData.positions) {
        if (pos?.title && typeof pos.title === 'string' && pos.title.trim().length > 2) {
          candidateTitles.push(pos.title.trim());
        }
      }
    }
    const roleKeywords = getRoleTitleKeywords(candidateTitles);

    const explanation = (skills.length > 0 || roleKeywords.length > 0)
      ? 'Showing relevant roles while we finish ranking your matches'
      : 'Here are recent roles to explore';
    return this.getDiscoveryFeed(excludeIds, explanation, { skills, roleKeywords });
  }

  /**
   * Get job recommendations split into two sections:
   *   - applyAndKnowToday: Internal (platform) jobs with exam/chat metadata
   *   - matchedForYou: External jobs with freshness/source metadata
   *
   * Used by the two-section discovery endpoint.
   */
  async getJobRecommendationsSectioned(candidateId: string): Promise<{
    applyAndKnowToday: any[];
    matchedForYou: any[];
  }> {
    try {
      const recommendations = await this.fetchScoredJobs(candidateId);
      if (!recommendations) {return { applyAndKnowToday: [], matchedForYou: [] };}

      const applyAndKnowToday = recommendations
        .filter(job => job.source === 'platform' || !job.externalUrl);

      const matchedForYou = recommendations
        .filter(job => job.source !== 'platform' && job.externalUrl)
        .slice(0, 20);

      console.log(`Sectioned: ${applyAndKnowToday.length} internal, ${matchedForYou.length} external`);
      return { applyAndKnowToday, matchedForYou };
    } catch (error) {
      console.error('Error fetching sectioned job recommendations:', error);
      throw error;
    }
  }

  async findMatchingCandidates(jobId: number): Promise<any[]> {
    try {
      const job = await this.getJobPosting(jobId);
      if (!job || !job.skills || job.skills.length === 0) {
        return [];
      }

      // 1. Fetch candidates with overlapping skills
      const candidates = await db
        .select()
        .from(candidateProfiles)
        .innerJoin(users, eq(candidateProfiles.userId, users.id))
        .where(
          or(...job.skills.map((skill: string) =>
            sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${candidateProfiles.skills}) AS cs WHERE LOWER(cs) = LOWER(${skill}))`
          ))
        )
        .limit(50);

      // 2. Score using the same scoreJob used in the candidate feed — single source of truth
      const matches = [];

      for (const { candidate_users: profile, users: user } of candidates as any[]) {
        const candSkills = parseSkillsInput(profile.skills);
        // Extract previous titles from parsing data
        const titles: string[] = [];
        const pd = profile.resumeParsingData as any;
        if (pd?.positions && Array.isArray(pd.positions)) {
          for (const pos of pd.positions) {
            if (pos.title && typeof pos.title === 'string' && pos.title.trim().length > 2) {
              titles.push(pos.title.trim());
            }
          }
        }
        // Parse candidate embedding if available
        let candEmb: number[] | undefined;
        if (profile.vectorEmbedding) {
          try { candEmb = JSON.parse(profile.vectorEmbedding); } catch { /* skip */ }
        }

        const score = scoreJob(candSkills, profile.experienceLevel, job, candEmb, titles, {
          location: profile.location,
          workType: profile.workType,
        });
        if (score.matchScore < 30) continue;

        matches.push({
          candidateId: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          profileImageUrl: user.profileImageUrl,
          skills: profile.skills,
          experience: profile.experience,
          matchScore: score.matchScore,
          aiExplanation: score.aiExplanation,
          skillMatches: score.skillMatches,
        });
      }

      // 3. Sort by score
      matches.sort((a, b) => b.matchScore - a.matchScore);
      return matches.slice(0, 20);
    } catch (error) {
      console.error('Error finding matching candidates:', error);
      throw error;
    }
  }

  async updateJobPosting(id: number, talentOwnerId: string, updates: Partial<InsertJobPosting>): Promise<JobPosting> {
    try {
      const updateData = {
        ...updates,
        ...(updates.skills ? { skills: normalizeSkills(updates.skills) } : {}),
        updatedAt: new Date(),
      };
      const [job] = await db
        .update(jobPostings)
        .set(updateData as any)
        .where(and(eq(jobPostings.id, id), eq(jobPostings.talentOwnerId, talentOwnerId)))
        .returning();
      return job;
    } catch (error) {
      console.error('Error updating job posting:', error);
      throw error;
    }
  }

  async deleteJobPosting(id: number, talentOwnerId: string): Promise<void> {
    try {
      await db
        .delete(jobPostings)
        .where(and(eq(jobPostings.id, id), eq(jobPostings.talentOwnerId, talentOwnerId)));
    } catch (error) {
      console.error('Error deleting job posting:', error);
      throw error;
    }
  }



  // Matching operations
  async createJobMatch(match: InsertJobMatch): Promise<JobMatch> {
    try {
      const [result] = await db.insert(jobMatches).values({
        ...match,
        matchReasons: match.matchReasons || [],
        skillMatches: match.skillMatches || []
      }).returning();
      return result;
    } catch (error) {
      console.error('Error creating job match:', error);
      throw error;
    }
  }

  async getMatchesForCandidate(candidateId: string): Promise<(JobMatch & { job: JobPosting; talentOwner: User })[]> {
    try {
      const results = await db
        .select({
          // Job match fields
          id: jobMatches.id,
          jobId: jobMatches.jobId,
          candidateId: jobMatches.candidateId,
          matchScore: jobMatches.matchScore,
          matchReasons: jobMatches.matchReasons,
          status: jobMatches.status,
          createdAt: jobMatches.createdAt,
          updatedAt: jobMatches.updatedAt,
          confidenceLevel: jobMatches.confidenceLevel,
          skillMatches: jobMatches.skillMatches,
          aiExplanation: jobMatches.aiExplanation,
          userFeedback: jobMatches.userFeedback,
          feedbackReason: jobMatches.feedbackReason,
          viewedAt: jobMatches.viewedAt,
          appliedAt: jobMatches.appliedAt,
          // Job fields
          job: {
            id: jobPostings.id,
            title: jobPostings.title,
            company: jobPostings.company,
            description: jobPostings.description,
            location: jobPostings.location,
            workType: jobPostings.workType,
            salaryMin: jobPostings.salaryMin,
            salaryMax: jobPostings.salaryMax,
            requirements: jobPostings.requirements,
            skills: jobPostings.skills,
            hasExam: jobPostings.hasExam,
            source: jobPostings.source,
            examPassingScore: jobPostings.examPassingScore,
            talentOwnerId: jobPostings.talentOwnerId
          },
          // Talent owner fields
          talentOwner: {
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email
          }
        })
        .from(jobMatches)
        .innerJoin(jobPostings, eq(jobMatches.jobId, jobPostings.id))
        .innerJoin(users, eq(jobPostings.talentOwnerId, users.id))
        .where(eq(jobMatches.candidateId, candidateId))
        .orderBy(desc(jobMatches.createdAt));

      return results as any;
    } catch (error) {
      console.error('Error fetching matches for candidate:', error);
      throw error;
    }
  }

  async getMatchesForJob(jobId: number): Promise<(JobMatch & { candidate: User; candidateProfile?: CandidateProfile })[]> {
    try {
      const matches = await db
        .select()
        .from(jobMatches)
        .innerJoin(users, eq(jobMatches.candidateId, users.id))
        .leftJoin(candidateProfiles, eq(jobMatches.candidateId, candidateProfiles.userId))
        .where(eq(jobMatches.jobId, jobId));

      return matches.map((m: any) => ({
        ...m.job_matches,
        candidate: m.users,
        candidateProfile: m.candidate_profiles
      }));
    } catch (error) {
      console.error('Error fetching matches for job:', error);
      throw error;
    }
  }

  async updateMatchStatus(matchId: number, status: string): Promise<JobMatch> {
    try {
      const [match] = await db
        .update(jobMatches)
        .set({ status: status as any, updatedAt: new Date() })
        .where(eq(jobMatches.id, matchId))
        .returning();
      return match;
    } catch (error) {
      console.error('Error updating match status:', error);
      throw error;
    }
  }

  async clearJobMatches(jobId: number): Promise<void> {
    try {
      await db
        .delete(jobMatches)
        .where(eq(jobMatches.jobId, jobId));
    } catch (error) {
      console.error('Error clearing job matches:', error);
      throw error;
    }
  }

  async updateJobMatchStatus(candidateId: string, jobId: number, status: string): Promise<void> {
    try {
      await db
        .update(jobMatches)
        .set({ status: status as any, updatedAt: new Date() })
        .where(and(eq(jobMatches.candidateId, candidateId), eq(jobMatches.jobId, jobId)));
    } catch (error) {
      console.error('Error updating job match status:', error);
      throw error;
    }
  }

  async getJobExam(jobId: number): Promise<any> {
    try {
      const [exam] = await db
        .select()
        .from(jobExams)
        .where(eq(jobExams.jobId, jobId));
      return exam;
    } catch (error) {
      console.error('Error fetching job exam:', error);
      throw error;
    }
  }

  async storeExamResult(result: any): Promise<void> {
    try {
      await db.transaction(async (tx) => {
        // Get exam and check for existing attempt atomically
        const [exam] = await tx.select().from(jobExams).where(eq(jobExams.jobId, result.jobId));
        if (!exam) {
          throw new Error('No exam found for this job');
        }

        // Check for existing attempt to prevent duplicates
        const [existing] = await tx.select({ id: examAttempts.id })
          .from(examAttempts)
          .where(and(
            eq(examAttempts.examId, exam.id),
            eq(examAttempts.candidateId, result.candidateId),
            eq(examAttempts.jobId, result.jobId),
          ));
        if (existing) {
          throw new Error('Exam already submitted for this job');
        }

        const passed = result.score >= (exam.passingScore || 70);
        const now = new Date();
        const deadline = passed ? new Date(now.getTime() + 24 * 60 * 60 * 1000) : null;

        await tx.insert(examAttempts).values({
          examId: exam.id,
          candidateId: result.candidateId,
          jobId: result.jobId,
          score: result.score,
          totalQuestions: result.totalQuestions,
          correctAnswers: result.correctAnswers,
          timeSpent: result.timeSpent,
          answers: result.answers,
          status: 'completed',
          passedExam: passed,
          qualifiedForChat: false, // Will be set during ranking
          completedAt: now,
          responseDeadlineAt: deadline,
          examFeedback: result.examFeedback ?? null,
        });
      });
    } catch (error) {
      console.error('Error storing exam result:', error);
      throw error;
    }
  }

  // Returns applications where candidate passed the exam but recruiter has not
  // acted (status still submitted/viewed) and the 24h deadline has passed.
  async getOverdueExamApplications(): Promise<{ applicationId: number; candidateId: string; jobTitle: string; company: string }[]> {
    try {
      const rows = await db.execute(sql`
        SELECT
          ja.id            AS "applicationId",
          ja.candidate_id  AS "candidateId",
          jp.title         AS "jobTitle",
          jp.company       AS "company"
        FROM exam_attempts ea
        JOIN job_applications ja
          ON ja.job_id = ea.job_id AND ja.candidate_id = ea.candidate_id
        JOIN job_postings jp ON jp.id = ea.job_id
        WHERE ea.passed_exam = true
          AND ea.response_deadline_at IS NOT NULL
          AND ea.response_deadline_at < NOW()
          AND ja.status IN ('submitted', 'viewed')
      `);
      return (rows as any).rows ?? (rows as any) as any[];
    } catch (error) {
      console.error('Error fetching overdue exam applications:', error);
      return [];
    }
  }

  async getApplicationsNearSLADeadline(hoursWindow: number): Promise<{ applicationId: number; candidateId: string; talentOwnerId: string; jobTitle: string; company: string; hoursLeft: number }[]> {
    try {
      const rows = await db.execute(sql`
        SELECT
          ja.id                                                      AS "applicationId",
          ja.candidate_id                                            AS "candidateId",
          jp.talent_owner_id                                         AS "talentOwnerId",
          jp.title                                                   AS "jobTitle",
          jp.company                                                 AS "company",
          ROUND(EXTRACT(EPOCH FROM (ea.response_deadline_at - NOW())) / 3600)::int AS "hoursLeft"
        FROM exam_attempts ea
        JOIN job_applications ja
          ON ja.job_id = ea.job_id AND ja.candidate_id = ea.candidate_id
        JOIN job_postings jp ON jp.id = ea.job_id
        WHERE ea.passed_exam = true
          AND ea.response_deadline_at IS NOT NULL
          AND ea.response_deadline_at > NOW()
          AND ea.response_deadline_at <= NOW() + (${hoursWindow + 1} || ' hours')::interval
          AND ja.status IN ('submitted', 'viewed')
      `);
      return (rows as any).rows ?? (rows as any) as any[];
    } catch (error) {
      console.error('Error fetching near-SLA applications:', error);
      return [];
    }
  }

  // Returns internal platform jobs that have been active for staleDays+ days
  // with no new applicant activity in the last 14 days — candidates for auto-close.
  async getStaleInternalJobs(staleDays = 30): Promise<{ id: number; title: string; company: string; createdAt: Date | null }[]> {
    try {
      if (!db) return [];
      const rows = await db.execute(sql`
        SELECT
          jp.id,
          jp.title,
          jp.company,
          jp.created_at AS "createdAt"
        FROM job_postings jp
        WHERE jp.status = 'active'
          AND (jp.source = 'platform' OR jp.source IS NULL OR jp.external_url IS NULL)
          AND jp.created_at < NOW() - (${staleDays} || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM job_applications ja
            WHERE ja.job_id = jp.id
              AND ja.updated_at > NOW() - INTERVAL '14 days'
          )
      `);
      return ((rows as any).rows ?? (rows as any)) as any[];
    } catch (error) {
      console.error('[storage] Error fetching stale internal jobs:', error);
      return [];
    }
  }

  // Set status='closed' for a list of job IDs (system-level, no ownership check).
  async closeJobsByIds(ids: number[]): Promise<number> {
    if (!db || ids.length === 0) return 0;
    try {
      const result = await db
        .update(jobPostings)
        .set({ status: 'closed', updatedAt: new Date() })
        .where(sql`${jobPostings.id} = ANY(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::int[])`);
      return (result as any).rowCount ?? ids.length;
    } catch (error) {
      console.error('[storage] Error closing jobs by IDs:', error);
      return 0;
    }
  }

  // Chat operations
  async createChatMessage(message: InsertChatMessage): Promise<ChatMessage> {
    try {
      const [result] = await db.insert(chatMessages).values(message).returning();
      return result;
    } catch (error) {
      console.error('Error creating chat message:', error);
      throw error;
    }
  }

  async getChatMessages(chatRoomId: number): Promise<any[]> {
    try {
      // Use raw SQL to return flat objects — Drizzle 0.39 with innerJoin + default select()
      // returns nested {chatMessages: {...}, users: {...}} objects which break callers.
      const rows = await db.execute(sql`
        SELECT
          cm.id,
          cm.chat_room_id AS "chatRoomId",
          cm.sender_id AS "senderId",
          cm.message,
          cm.created_at AS "createdAt",
          u.first_name AS "senderFirstName",
          u.last_name AS "senderLastName",
          u.email AS "senderEmail"
        FROM chat_messages cm
        INNER JOIN users u ON cm.sender_id = u.id
        WHERE cm.chat_room_id = ${chatRoomId}
        ORDER BY cm.created_at ASC
      `);
      // Convert RowList → plain array so res.json() serializes cleanly
      return Array.from(rows).map((r: any) => ({ ...r }));
    } catch (error) {
      console.error('Error fetching chat messages:', error);
      throw error;
    }
  }

  // Activity operations
  async createActivityLog(userId: string, type: string, description: string, metadata?: any): Promise<ActivityLog> {
    try {
      const [result] = await db
        .insert(activityLogs)
        .values({ userId, type, description, metadata })
        .returning();
      return result;
    } catch (error) {
      console.error('Error creating activity log:', error);
      throw error;
    }
  }

  async getActivityLogs(userId: string, limit = 10): Promise<ActivityLog[]> {
    try {
      return await db
        .select()
        .from(activityLogs)
        .where(eq(activityLogs.userId, userId))
        .orderBy(desc(activityLogs.createdAt))
        .limit(limit);
    } catch (error) {
      console.error('Error fetching activity logs:', error);
      throw error;
    }
  }

  // Statistics and analytics
  async getCandidateStats(candidateId: string): Promise<any> {
    try {
      // Run all queries in parallel to avoid sequential DB round-trips (fixes Vercel 504 timeouts)
      const [applications, matches, profile, activeChats] = await Promise.all([
        db.select().from(jobApplications).where(eq(jobApplications.candidateId, candidateId)),
        db.select().from(jobMatches).where(eq(jobMatches.candidateId, candidateId)),
        this.getCandidateUser(candidateId),
        db.select().from(chatRooms).where(eq(chatRooms.candidateId, candidateId)),
      ]);

      return {
        newMatches: matches.filter(m => m.status === 'pending').length,
        profileViews: profile?.profileViews || 0,
        activeChats: activeChats.length,
        applicationsPending: applications.filter(a => a.status === 'submitted' || a.status === 'viewed').length,
        applicationsRejected: applications.filter(a => a.status === 'rejected').length,
        applicationsAccepted: applications.filter(a => a.status === 'offer').length,
      };
    } catch (error) {
      console.error('Error fetching candidate stats:', error);
      throw error;
    }
  }

  async getRecruiterStats(talentOwnerId: string): Promise<any> {
    try {
      const jobs = await db
        .select()
        .from(jobPostings)
        .where(eq(jobPostings.talentOwnerId, talentOwnerId));

      const jobIds = jobs.map(j => j.id);

      // Run dependent queries in parallel (fixes Vercel 504 timeouts)
      const [applications, matches, activeChats] = jobIds.length > 0
        ? await Promise.all([
            db.select().from(jobApplications).where(inArray(jobApplications.jobId, jobIds)),
            db.select().from(jobMatches).where(inArray(jobMatches.jobId, jobIds)),
            db.select().from(chatRooms).where(inArray(chatRooms.jobId, jobIds)),
          ])
        : [[], [], []];

      return {
        activeJobs: jobs.filter(j => j.status === 'active').length,
        totalMatches: matches.length,
        activeChats: activeChats.length,
        hires: applications.filter(a => a.status === 'offer').length,
        pendingApplications: applications.filter(a => a.status === 'submitted').length,
        viewedApplications: applications.filter(a => a.status === 'viewed').length,
      };
    } catch (error) {
      console.error('Error fetching recruiter stats:', error);
      throw error;
    }
  }

  async getCandidatesForRecruiter(talentOwnerId: string): Promise<any[]> {
    try {
      const jobs = await this.getJobPostings(talentOwnerId);
      const jobIds = jobs.map(j => j.id);

      if (jobIds.length === 0) {
        return [];
      }

      return await db
        .select({
          application: jobApplications,
          candidate: users,
          profile: candidateProfiles,
          job: jobPostings
        })
        .from(jobApplications)
        .innerJoin(users, eq(jobApplications.candidateId, users.id))
        .leftJoin(candidateProfiles, eq(jobApplications.candidateId, candidateProfiles.userId))
        .innerJoin(jobPostings, eq(jobApplications.jobId, jobPostings.id))
        .where(inArray(jobApplications.jobId, jobIds))
        .orderBy(desc(jobApplications.createdAt));
    } catch (error) {
      console.error('Error fetching candidates for recruiter:', error);
      throw error;
    }
  }

  // Application operations
  async getApplicationsWithStatus(candidateId: string): Promise<any[]> {
    try {
      const rows = await db.execute(sql`
        SELECT
          ja.id,
          ja.job_id AS "jobId",
          ja.status,
          ja.applied_at AS "appliedAt",
          ja.auto_filled AS "autoFilled",
          ja.metadata,
          ja.created_at AS "createdAt",
          jp.id AS "jobPostingId",
          jp.title AS "jobTitle",
          jp.company AS "jobCompany",
          jp.location AS "jobLocation",
          jp.work_type AS "jobWorkType",
          jp.external_url AS "jobExternalUrl",
          jp.has_exam AS "jobHasExam",
          cr.id AS "chatRoomId"
        FROM job_applications ja
        INNER JOIN job_postings jp ON ja.job_id = jp.id
        LEFT JOIN chat_rooms cr ON cr.job_id = ja.job_id AND cr.candidate_id = ja.candidate_id
        WHERE ja.candidate_id = ${candidateId}
        ORDER BY ja.created_at DESC
      `);

      return Array.from(rows).map((r: any) => ({
        id: r.id,
        jobId: r.jobId,
        status: r.status,
        appliedAt: r.appliedAt,
        autoFilled: r.autoFilled,
        metadata: r.metadata,
        createdAt: r.createdAt,
        chatRoomId: r.chatRoomId ?? null,
        job: {
          id: r.jobPostingId,
          title: r.jobTitle,
          company: r.jobCompany,
          location: r.jobLocation,
          workType: r.jobWorkType,
          externalUrl: r.jobExternalUrl,
          hasExam: r.jobHasExam,
        },
      }));
    } catch (error) {
      console.error('Error fetching applications with status:', error);
      throw error;
    }
  }

  async getApplicantsForJob(jobId: number, talentOwnerId: string): Promise<any[]> {
    try {
      // First, verify ownership of the job posting
      const [job] = await db
        .select()
        .from(jobPostings)
        .where(and(eq(jobPostings.id, jobId), eq(jobPostings.talentOwnerId, talentOwnerId)));

      if (!job) {
        console.warn(`[storage] Unauthorized attempt to access applicants for job ${jobId} by user ${talentOwnerId}`);
        return []; // Return empty array if user does not own the job
      }

      // Use raw SQL to bypass Drizzle ORM 0.39 bug with leftJoin + orderBy
      // (TypeError: Cannot convert undefined or null to object in orderSelectedFields)
      const rows = await db.execute(sql`
        SELECT
          ja.id AS "applicationId",
          ja.status,
          ja.applied_at AS "appliedAt",
          u.id AS "candidateId",
          u.first_name AS "candidateFirstName",
          u.last_name AS "candidateLastName",
          u.email AS "candidateEmail",
          cp.skills,
          cp.experience,
          cp.resume_url AS "resumeUrl",
          cp.linkedin_url AS "linkedinUrl",
          cp.github_url AS "githubUrl",
          cp.portfolio_url AS "portfolioUrl",
          jm.match_score AS "matchScore",
          jm.ai_explanation AS "aiExplanation",
          ea.score AS "examScore",
          ea.passed_exam AS "examPassed",
          ea.ranking AS "examRanking",
          ea.qualified_for_chat AS "qualifiedForChat",
          ea.response_deadline_at AS "responseDeadlineAt"
        FROM job_applications ja
        INNER JOIN users u ON ja.candidate_id = u.id
        LEFT JOIN candidate_users cp ON ja.candidate_id = cp.user_id
        LEFT JOIN job_matches jm ON jm.candidate_id = ja.candidate_id AND jm.job_id = ja.job_id
        LEFT JOIN exam_attempts ea ON ea.candidate_id = ja.candidate_id AND ea.job_id = ja.job_id
        WHERE ja.job_id = ${jobId}
          AND ja.status != 'pending_exam'
        ORDER BY ea.score DESC NULLS LAST, ja.applied_at DESC
      `);

      // Re-shape flat rows into the nested structure callers expect
      return (rows as any[]).map((row: any) => ({
        applicationId: row.applicationId,
        status: row.status,
        appliedAt: row.appliedAt,
        candidate: {
          id: row.candidateId,
          firstName: row.candidateFirstName,
          lastName: row.candidateLastName,
          email: row.candidateEmail,
        },
        profile: {
          skills: row.skills,
          experience: row.experience,
          resumeUrl: row.resumeUrl,
          linkedinUrl: row.linkedinUrl,
          githubUrl: row.githubUrl,
          portfolioUrl: row.portfolioUrl,
        },
        match: {
          matchScore: row.matchScore,
          aiExplanation: row.aiExplanation,
        },
        examScore: row.examScore,
        examPassed: row.examPassed,
        examRanking: row.examRanking,
        qualifiedForChat: row.qualifiedForChat,
        responseDeadlineAt: row.responseDeadlineAt,
      }));
    } catch (error) {
      console.error(`Error fetching applicants for job ${jobId}:`, error);
      throw error;
    }
  }

  async updateApplicationStatus(applicationId: number, status: string, talentOwnerId: string): Promise<any> {
    try {
      // Verify that the talent owner has permission to update this application
      const [application] = await db
        .select({
          jobOwnerId: jobPostings.talentOwnerId
        })
        .from(jobApplications)
        .innerJoin(jobPostings, eq(jobApplications.jobId, jobPostings.id))
        .where(eq(jobApplications.id, applicationId));

      if (!application || application.jobOwnerId !== talentOwnerId) {
        throw new Error("Unauthorized: You do not have permission to update this application.");
      }

      const [updatedApplication] = await db
        .update(jobApplications)
        .set({
          status: status as any,
          updatedAt: new Date(),
        })
        .where(eq(jobApplications.id, applicationId))
        .returning();
      return updatedApplication;
    } catch (error) {
      console.error('Error updating application status:', error);
      throw error;
    }
  }

  async updateApplicationStatusByCandidate(applicationId: number, status: string): Promise<any> {
    try {
      const now = new Date();
      const [updatedApplication] = await db
        .update(jobApplications)
        .set({
          status: status as any,
          updatedAt: now,
          lastStatusUpdate: now,
        })
        .where(eq(jobApplications.id, applicationId))
        .returning();
      return updatedApplication;
    } catch (error) {
      console.error('Error updating application status by candidate:', error);
      throw error;
    }
  }

  async getApplicationByJobAndCandidate(jobId: number, candidateId: string): Promise<any> {
    try {
      const [application] = await db
        .select()
        .from(jobApplications)
        .where(and(
          eq(jobApplications.jobId, jobId),
          eq(jobApplications.candidateId, candidateId)
        ));
      return application;
    } catch (error) {
      console.error('Error fetching application by job and candidate:', error);
      throw error;
    }
  }

  async createJobApplication(application: any): Promise<any> {
    try {
      const [result] = await db
        .insert(jobApplications)
        .values(application)
        .returning();
      return result;
    } catch (error) {
      console.error('Error creating job application:', error);
      throw error;
    }
  }

  // Notification operations
  async getNotificationPreferences(userId: string): Promise<NotificationPreferences | undefined> {
    try {
      const [prefs] = await db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, userId));
      return prefs;
    } catch (error) {
      console.error('Error fetching notification preferences:', error);
      throw error;
    }
  }

  async updateNotificationPreferences(userId: string, preferences: Partial<InsertNotificationPreferences>): Promise<NotificationPreferences> {
    try {
      const [result] = await db
        .insert(notificationPreferences)
        .values({ userId, ...preferences })
        .onConflictDoUpdate({
          target: notificationPreferences.userId,
          set: { ...preferences, updatedAt: new Date() },
        })
        .returning();
      return result;
    } catch (error) {
      console.error('Error updating notification preferences:', error);
      throw error;
    }
  }

  async getNotifications(userId: string): Promise<any[]> {
    try {
      return await db
        .select()
        .from(notifications)
        .where(and(
          eq(notifications.userId, userId),
          eq(notifications.read, false)
        ))
        .orderBy(desc(notifications.createdAt))
        .limit(50);
    } catch (error) {
      console.error('Error fetching notifications:', error);
      throw error;
    }
  }

  async markNotificationAsRead(notificationId: number, userId: string): Promise<void> {
    try {
      const result = await db
        .update(notifications)
        .set({ read: true, readAt: new Date() })
        .where(and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId)
        ));
      console.log(`Mark notification ${notificationId} as read for user ${userId}, result:`, result);
    } catch (error) {
      console.error('Error marking notification as read:', error);
      throw error;
    }
  }

  async markAllNotificationsAsRead(userId: string): Promise<void> {
    try {
      const result = await db
        .update(notifications)
        .set({ read: true, readAt: new Date() })
        .where(and(
          eq(notifications.userId, userId),
          eq(notifications.read, false)
        ));
      console.log('Mark all notifications as read result:', result);
    } catch (error) {
      console.error('Error marking all notifications as read:', error);
      throw error;
    }
  }

  // Exam operations
  async createJobExam(exam: any): Promise<any> {
    try {
      const [result] = await db.insert(jobExams).values(exam).returning();
      return result;
    } catch (error) {
      console.error('Error creating job exam:', error);
      throw error;
    }
  }

  async createExamAttempt(attempt: any): Promise<any> {
    try {
      const [result] = await db.insert(examAttempts).values(attempt).returning();
      return result;
    } catch (error) {
      console.error('Error creating exam attempt:', error);
      throw error;
    }
  }

  async updateExamAttempt(attemptId: number, data: any): Promise<any> {
    try {
      const [result] = await db
        .update(examAttempts)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(examAttempts.id, attemptId))
        .returning();
      return result;
    } catch (error) {
      console.error('Error updating exam attempt:', error);
      throw error;
    }
  }

  async getExamAttempts(jobId: number): Promise<any[]> {
    try {
      return await db
        .select()
        .from(examAttempts)
        .where(eq(examAttempts.jobId, jobId))
        .orderBy(desc(examAttempts.createdAt));
    } catch (error) {
      console.error('Error fetching exam attempts:', error);
      throw error;
    }
  }

  async rankCandidatesByExamScore(jobId: number): Promise<void> {
    try {
      const job = await this.getJobPosting(jobId);
      if (!job || !job.maxChatCandidates) {return;}

      // Use a transaction to ensure atomic ranking updates
      await db.transaction(async (tx) => {
        const attempts = await tx
          .select()
          .from(examAttempts)
          .where(and(
            eq(examAttempts.jobId, jobId),
            eq(examAttempts.status, 'completed'),
            eq(examAttempts.passedExam, true)
          ))
          .orderBy(desc(examAttempts.score))
          .for('update'); // Lock rows to prevent concurrent modifications

        // Update rankings and grant chat access to top candidates
        for (let i = 0; i < attempts.length; i++) {
          const ranking = i + 1;
          const qualifiedForChat = ranking <= job.maxChatCandidates;

          await tx
            .update(examAttempts)
            .set({
              ranking,
              qualifiedForChat,
              updatedAt: new Date()
            })
            .where(eq(examAttempts.id, attempts[i].id));

          // Grant chat access to top candidates (outside transaction to avoid deadlock)
          if (qualifiedForChat && job.hiringManagerId) {
            // We commit the transaction first, then grant chat access
          }
        }

        return attempts;
      });

      // Grant chat access after transaction completes to avoid deadlocks
      const attempts = await db
        .select()
        .from(examAttempts)
        .where(and(
          eq(examAttempts.jobId, jobId),
          eq(examAttempts.status, 'completed'),
          eq(examAttempts.passedExam, true),
          eq(examAttempts.qualifiedForChat, true)
        ))
        .orderBy(asc(examAttempts.ranking));

      for (const attempt of attempts) {
        if (attempt.ranking && attempt.ranking <= job.maxChatCandidates) {
          await this.grantChatAccess(jobId, attempt.candidateId, attempt.id, attempt.ranking);
        }
      }
    } catch (error) {
      console.error('Error ranking candidates by exam score:', error);
      throw error;
    }
  }

  async closeJobAndNotifyCandidates(jobId: number, talentOwnerId: string): Promise<void> {
    try {
      const job = await this.getJobPosting(jobId);
      if (!job || job.talentOwnerId !== talentOwnerId) {
        throw new Error('Job not found or unauthorized');
      }

      // Status is already set to 'closed' by the route before calling this method.
      // This method is responsible only for notifications.
      const { notificationService } = await import('./notification-service');
      // Only notify candidates who completed their application (exam takers for hasExam jobs)
      const applications = await db
        .select()
        .from(jobApplications)
        .where(and(
          eq(jobApplications.jobId, jobId),
          sql`${jobApplications.status} != 'pending_exam'`
        ));

      const attempts = await this.getExamAttempts(jobId);
      const sortedAttempts = attempts
        .filter((a: any) => a.status === 'completed' && a.score !== null)
        .sort((a: any, b: any) => (b.score || 0) - (a.score || 0));

      for (const application of applications) {
        const ranking = sortedAttempts.findIndex((a: any) => a.candidateId === application.candidateId) + 1;
        const attempt = attempts.find((a: any) => a.candidateId === application.candidateId);
        const passedExam = attempt ? attempt.passedExam : false;

        await notificationService.notifyJobExpired(
          application.candidateId,
          job.title,
          job.company,
          application.id,
          ranking || undefined,
          sortedAttempts.length || undefined,
          passedExam
        );
      }

      await notificationService.notifyJobExpiredToTalentOwner(
        talentOwnerId,
        job.title,
        applications.length
      );

      console.log(`[Storage] Notified ${applications.length} candidates of job closure: ${jobId}`);
    } catch (error) {
      console.error('Error notifying candidates of job closure:', error);
      throw error;
    }
  }

  // Chat room operations
  async getChatRoom(jobId: number, candidateId: string): Promise<ChatRoom | undefined> {
    try {
      const [room] = await db
        .select()
        .from(chatRooms)
        .where(and(
          eq(chatRooms.jobId, jobId),
          eq(chatRooms.candidateId, candidateId)
        ));
      return room;
    } catch (error) {
      console.error('Error fetching chat room:', error);
      throw error;
    }
  }

  async createChatRoom(data: any): Promise<ChatRoom> {
    try {
      const [room] = await db
        .insert(chatRooms)
        .values({
          jobId: data.jobId,
          candidateId: data.candidateId,
          hiringManagerId: data.hiringManagerId,
          examAttemptId: data.examAttemptId,
          candidateRanking: data.ranking,
          createdAt: new Date(),
          updatedAt: new Date()
        })
        .returning();
      return room;
    } catch (error) {
      console.error('Error creating chat room:', error);
      throw error;
    }
  }

  async getChatRoomsForUser(userId: string): Promise<(ChatRoom & { job: JobPosting; hiringManager: User })[]> {
    try {
      const rooms = await db
        .select()
        .from(chatRooms)
        .where(or(
          eq(chatRooms.candidateId, userId),
          eq(chatRooms.hiringManagerId, userId)
        ))
        .orderBy(desc(chatRooms.createdAt));

      const enrichedRooms = [];
      for (const room of rooms) {
        const [job, hiringManager, candidate] = await Promise.all([
          this.getJobPosting(room.jobId),
          this.getUser(room.hiringManagerId),
          this.getUser(room.candidateId),
        ]);

        if (job && hiringManager) {
          enrichedRooms.push({
            ...room,
            job,
            hiringManager,
            candidate,
            // match shape expected by ChatInterface
            match: {
              job,
              recruiter: hiringManager,
              candidate,
            },
          });
        }
      }

      return enrichedRooms;
    } catch (error) {
      console.error('Error fetching chat rooms for user:', error);
      throw error;
    }
  }

  async grantChatAccess(jobId: number, candidateId: string, examAttemptId: number, ranking: number): Promise<ChatRoom> {
    try {
      const job = await this.getJobPosting(jobId);
      if (!job) {
        throw new Error('Job not found');
      }

      const room = await this.createChatRoom({
        jobId,
        candidateId,
        hiringManagerId: job.hiringManagerId || job.talentOwnerId,
        examAttemptId,
        ranking
      });

      // Create notification for chat access
      await this.createNotification({
        userId: candidateId,
        type: 'chat_access_granted',
        title: 'Chat Access Granted',
        message: `You now have chat access for ${job.title}`,
        metadata: { jobId, ranking }
      });

      return room;
    } catch (error) {
      console.error('Error granting chat access:', error);
      throw error;
    }
  }

  async createNotification(notification: any): Promise<any> {
    try {
      const [result] = await db.insert(notifications).values({
        ...notification,
        read: false,
        createdAt: new Date()
      }).returning();
      return result;
    } catch (error) {
      console.error('Error creating notification:', error);
      throw error;
    }
  }

  // Enhanced candidate operations
  async getApplicationsForCandidate(candidateId: string): Promise<any[]> {
    try {
      return await db
        .select()
        .from(jobApplications)
        .where(eq(jobApplications.candidateId, candidateId))
        .orderBy(desc(jobApplications.createdAt));
    } catch (error) {
      console.error('Error fetching applications for candidate:', error);
      return [];
    }
  }

  async getActivityForCandidate(candidateId: string): Promise<any[]> {
    try {
      return await db
        .select()
        .from(activityLogs)
        .where(eq(activityLogs.userId, candidateId))
        .orderBy(desc(activityLogs.createdAt))
        .limit(50);
    } catch (error) {
      console.error('Error fetching activity for candidate:', error);
      return [];
    }
  }





  async getAvailableNotificationUsers(): Promise<string[]> {
    const result = await db.selectDistinct({ userId: notifications.userId }).from(notifications);
    return result.map(r => r.userId);
  }

  // Application Intelligence operations (Revolutionary feedback system)
  async getApplicationById(applicationId: number): Promise<any> {
    try {
      const [application] = await db
        .select()
        .from(jobApplications)
        .leftJoin(jobPostings, eq(jobApplications.jobId, jobPostings.id))
        .where(eq(jobApplications.id, applicationId));

      return application ? {
        ...(application as any).job_applications,
        job: (application as any).job_postings
      } : undefined;
    } catch (error) {
      console.error('Error fetching application by ID:', error);
      throw error;
    }
  }

  async createApplicationEvent(event: any): Promise<any> {
    try {
      // Import the applicationEvents table from schema
      const { applicationEvents } = await import("@shared/schema");

      const [result] = await db.insert(applicationEvents).values({
        applicationId: event.applicationId,
        eventType: event.eventType,
        actorRole: event.actorRole,
        actorName: event.actorName,
        actorTitle: event.actorTitle,
        viewDuration: event.viewDuration,
        candidateScore: event.candidateScore,
        candidateRanking: event.candidateRanking,
        totalApplicants: event.totalApplicants,
        feedback: event.feedback,
        nextSteps: event.nextSteps,
        competitorUser: event.competitorUser,
        visible: event.visible ?? true
      }).returning();

      return result;
    } catch (error) {
      console.error('Error creating application event:', error);
      throw error;
    }
  }

  async getApplicationEvents(applicationId: number): Promise<any[]> {
    try {
      const { applicationEvents } = await import("@shared/schema");

      return await db
        .select()
        .from(applicationEvents)
        .where(eq(applicationEvents.applicationId, applicationId))
        .orderBy(desc(applicationEvents.createdAt));
    } catch (error) {
      console.error('Error fetching application events:', error);
      return [];
    }
  }

  async getApplicationInsights(applicationId: number): Promise<any> {
    try {
      const { applicationInsights } = await import("@shared/schema");

      const [insights] = await db
        .select()
        .from(applicationInsights)
        .where(eq(applicationInsights.applicationId, applicationId))
        .orderBy(desc(applicationInsights.createdAt))
        .limit(1);

      return insights;
    } catch (error) {
      console.error('Error fetching application insights:', error);
      return null;
    }
  }

  async createApplicationInsights(insights: any): Promise<any> {
    try {
      const { applicationInsights } = await import("@shared/schema");

      const [result] = await db.insert(applicationInsights).values({
        candidateId: insights.candidateId,
        applicationId: insights.applicationId,
        strengthsIdentified: insights.strengthsIdentified,
        improvementAreas: insights.improvementAreas,
        benchmarkViewTime: insights.benchmarkViewTime,
        actualViewTime: insights.actualViewTime,
        benchmarkScore: insights.benchmarkScore,
        actualScore: insights.actualScore,
        similarSuccessfulUsers: insights.similarSuccessfulUsers,
        recommendedActions: insights.recommendedActions,
        successProbability: insights.successProbability,
        supportiveMessage: insights.supportiveMessage
      }).returning();

      return result;
    } catch (error) {
      console.error('Error creating application insights:', error);
      throw error;
    }
  }

  async getApplicationsForTalent(talentId: string): Promise<any[]> {
    try {
      // Get all applications for jobs owned by this talent
      const results = await db
        .select({
          application: jobApplications,
          candidate: candidateProfiles,
          job: jobPostings,
          user: users
        })
        .from(jobApplications)
        .leftJoin(candidateProfiles, eq(jobApplications.candidateId, candidateProfiles.userId))
        .leftJoin(jobPostings, eq(jobApplications.jobId, jobPostings.id))
        .leftJoin(users, eq(candidateProfiles.userId, users.id))
        .where(eq(jobPostings.talentOwnerId, talentId));

      return results.map(({ application, candidate, job, user }) => ({
        id: application.id.toString(),
        candidateId: user?.id,
        jobId: job?.id,
        candidateName: `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || user?.email?.split('@')[0] || 'Unknown',
        candidateEmail: user?.email,
        jobTitle: job?.title,
        appliedAt: application.appliedAt?.toISOString(),
        status: application.status,
        matchScore: candidate?.matchScore || 0,
        skills: candidate?.skills || [],
        experience: candidate?.experience || '',
        location: candidate?.location || '',
        resumeUrl: candidate?.resumeUrl,
        // Intelligence data stored in application
        viewedAt: application.viewedAt?.toISOString(),
        viewDuration: application.viewDuration,
        ranking: application.ranking,
        totalApplicants: application.totalApplicants,
        feedback: application.feedback,
        rating: application.rating,
        nextSteps: application.nextSteps,
        transparencyLevel: application.transparencyLevel || 'partial'
      }));
    } catch (error) {
      console.error('Error getting applications for talent:', error);
      throw error;
    }
  }

  async updateTalentTransparencySettings(talentId: string, settings: any): Promise<any> {
    try {
      // Store talent transparency preferences in talent owner profile
      const [result] = await db
        .update(talentOwnerProfiles)
        .set({
          transparencySettings: settings,
          updatedAt: new Date()
        })
        .where(eq(talentOwnerProfiles.userId, talentId))
        .returning();

      return result;
    } catch (error) {
      console.error('Error updating transparency settings:', error);
      throw error;
    }
  }

  async updateApplicationIntelligence(applicationId: number, updates: any): Promise<any> {
    try {
      const [result] = await db
        .update(jobApplications)
        .set({
          ...updates,
          updatedAt: new Date()
        })
        .where(eq(jobApplications.id, applicationId))
        .returning();
      return result;
    } catch (error) {
      console.error('Error updating application intelligence:', error);
      throw error;
    }
  }

  // Interview operations
  async createInterview(interview: any): Promise<any> {
    try {
      const [result] = await db.insert(interviews).values({
        candidateId: interview.candidateId,
        interviewerId: interview.interviewerId,
        jobId: interview.jobId,
        applicationId: interview.applicationId,
        scheduledAt: new Date(interview.scheduledAt),
        duration: interview.duration || 60,
        platform: interview.platform || 'video',
        meetingLink: interview.meetingLink,
        notes: interview.notes,
        status: 'scheduled',
      }).returning();

      // Update application status to interview_scheduled
      await db
        .update(jobApplications)
        .set({
          status: 'interview_scheduled',
          interviewLink: interview.meetingLink,
          updatedAt: new Date()
        })
        .where(eq(jobApplications.id, interview.applicationId));

      return result;
    } catch (error) {
      console.error('Error creating interview:', error);
      throw error;
    }
  }

  // Screening questions operations
  async getScreeningQuestions(jobId: number): Promise<any[]> {
    try {
      return await db
        .select()
        .from(screeningQuestions)
        .where(eq(screeningQuestions.jobId, jobId))
        .orderBy(screeningQuestions.sortOrder);
    } catch (error) {
      console.error('Error fetching screening questions:', error);
      throw error;
    }
  }

  async saveScreeningQuestions(jobId: number, questions: any[]): Promise<any[]> {
    try {
      // Delete existing questions for this job
      await db.delete(screeningQuestions).where(eq(screeningQuestions.jobId, jobId));

      // Insert new questions
      if (questions.length === 0) {return [];}

      const toInsert = questions.map((q, index) => ({
        jobId,
        question: q.question,
        questionType: q.questionType || 'text',
        options: q.options || [],
        isRequired: q.isRequired ?? true,
        sortOrder: index,
      }));

      const result = await db
        .insert(screeningQuestions)
        .values(toInsert)
        .returning();

      return result;
    } catch (error) {
      console.error('Error saving screening questions:', error);
      throw error;
    }
  }

  async saveScreeningAnswers(applicationId: number, answers: any[]): Promise<any[]> {
    try {
      const results = [];
      for (const answer of answers) {
        const [result] = await db
          .insert(screeningAnswers)
          .values({
            applicationId,
            questionId: answer.questionId,
            answer: answer.answer,
          })
          .onConflictDoUpdate({
            target: [screeningAnswers.applicationId, screeningAnswers.questionId],
            set: { answer: answer.answer },
          })
          .returning();
        results.push(result);
      }
      return results;
    } catch (error) {
      console.error('Error saving screening answers:', error);
      throw error;
    }
  }

  // ==========================================
  // AGENT TASK OPERATIONS
  // ==========================================

  // ── Invite Code Operations ──────────────────────────────────────────────────

  async validateAndRedeemInviteCode(code: string, userId: string, role: string): Promise<{ valid: boolean; error?: string; code?: string }> {
    try {
      const [invite] = await db
        .select()
        .from(inviteCodes)
        .where(eq(inviteCodes.code, code.trim().toUpperCase()))
        .limit(1);

      if (!invite) return { valid: false, error: 'Invalid invite code' };
      if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) return { valid: false, error: 'Invite code has expired' };
      if (invite.maxUses !== -1 && invite.usedCount >= (invite.maxUses ?? 1)) return { valid: false, error: 'Invite code has been fully used' };
      if (invite.role !== 'any' && invite.role !== role) return { valid: false, error: `This invite code is for ${invite.role} accounts only` };

      // Check if user already redeemed any code
      const [existing] = await db
        .select()
        .from(inviteCodeRedemptions)
        .where(eq(inviteCodeRedemptions.userId, userId))
        .limit(1);
      if (existing) return { valid: true, code: invite.code }; // already redeemed — allow through

      // Redeem: increment count + record redemption
      await db.update(inviteCodes).set({ usedCount: invite.usedCount + 1 }).where(eq(inviteCodes.id, invite.id));
      await db.insert(inviteCodeRedemptions).values({ codeId: invite.id, userId });

      return { valid: true, code: invite.code };
    } catch (error) {
      console.error('[Storage] Invite code validation error:', error);
      return { valid: false, error: 'Failed to validate invite code' };
    }
  }

  async createInviteCode(data: { code: string; description?: string; role?: string; maxUses?: number; createdBy?: string; expiresAt?: Date }): Promise<any> {
    const [result] = await db.insert(inviteCodes).values({
      code: data.code.toUpperCase(),
      description: data.description ?? null,
      role: (data.role as any) ?? 'any',
      maxUses: data.maxUses ?? 1,
      createdBy: data.createdBy ?? 'admin',
      expiresAt: data.expiresAt ?? null,
    }).returning();
    return result;
  }

  async listInviteCodes(): Promise<any[]> {
    return db.select().from(inviteCodes).orderBy(desc(inviteCodes.createdAt));
  }

  // ── Daily Usage Limit Operations ────────────────────────────────────────────

  async checkDailyLimit(userId: string, action: string, limit: number): Promise<{ allowed: boolean; used: number; limit: number }> {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD UTC
    const [row] = await db
      .select()
      .from(dailyUsageLimits)
      .where(and(
        eq(dailyUsageLimits.userId, userId),
        eq(dailyUsageLimits.action, action),
        eq(dailyUsageLimits.date, today),
      ))
      .limit(1);

    const used = row?.count ?? 0;
    return { allowed: used < limit, used, limit };
  }

async incrementDailyUsage(userId: string, action: string): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    await db.execute(sql`
      INSERT INTO daily_usage_limits (user_id, action, date, count)
      VALUES (${userId}, ${action}, ${today}, 1)
      ON CONFLICT (user_id, action, date)
      DO UPDATE SET count = daily_usage_limits.count + 1
    `);
  }
}

export const storage = new DatabaseStorage();

