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
import { isRecentlyVerifiedLive, LIVE_BADGE_MAX_AGE_HOURS } from "../shared/liveness.js";
import { db } from "./db";
import { eq, desc, asc, and, or } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { sql, isNotNull, type SQL } from "drizzle-orm/sql";
import { inArray } from "drizzle-orm/sql/expressions";
import { jobPostUrlSqlCondition } from "./lib/job-post-url";
import { supabaseAdmin } from "./lib/supabase-admin";
import { extractHardRequirements, verdictFor, yearsFromPositions, type CandidateFacts } from './lib/hard-requirements';
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
  refundParseAttempt(userId: string): Promise<void>;

  // Talent Owner operations
  getTalentOwnerProfile(userId: string): Promise<TalentOwnerProfile | undefined>;
  upsertTalentOwnerProfile(profile: InsertTalentOwnerProfile): Promise<TalentOwnerProfile>;


  // Job operations
  createJobPosting(job: InsertJobPosting): Promise<JobPosting>;
  getJobPostings(recruiterId: string): Promise<JobPosting[]>;
  getJobPosting(id: number): Promise<JobPosting | undefined>;
  getJobRecommendations(candidateId: string, filters?: FeedFilters, pagination?: { page: number; limit: number }, retrieval?: FeedRetrievalOptions): Promise<{ jobs: any[]; total: number; page: number; hasMore: boolean }>;
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
  deleteClosedApplicationsByCandidate(candidateId: string): Promise<number>;
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
  validateInviteCode(code: string, role: string): Promise<{ valid: boolean; error?: string; invite?: any }>;
  redeemInviteCode(invite: { id: number }, userId: string): Promise<void>;
  createInviteCode(data: { code: string; description?: string; role?: string; maxUses?: number; createdBy?: string; expiresAt?: Date }): Promise<any>;
  listInviteCodes(): Promise<any[]>;

  // Daily usage limit operations
  checkDailyLimit(userId: string, action: string, limit: number): Promise<{ allowed: boolean; used: number; limit: number }>;
  incrementDailyUsage(userId: string, action: string): Promise<void>;
}

// Sources that represent a direct-from-company scrape (deep link to the
// company's actual ATS posting), as opposed to an aggregator.
//
// The scrape-all-company-jobs script emits `ATS:<atsType>` while the older
// adzuna-migration scripts emit the bare `<atsType>`. Both forms are accepted,
// but by normalising the prefix away rather than listing both spellings: the
// previous dual-listing silently omitted ATS:smartrecruiters, which is 23.8K
// live jobs and the second-largest source, so that whole employer board went
// unbadged in the feed.
const ATS_SOURCES = new Set([
  'greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'workday',
  'smartrecruiters', 'breezy', 'company-api', 'platform',
]);
function normalizeSource(source: string): string {
  return source.toLowerCase().replace(/^ats:/, '');
}
function isFromAts(source: string | null | undefined): boolean {
  if (!source) return false;
  return ATS_SOURCES.has(normalizeSource(source));
}

// Escape regex metacharacters so a user-supplied skill (e.g. ".NET", "C++") can be
// safely embedded inside a Postgres POSIX regex pattern.
function escapePgRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matched-feed retrieval lane sizes (see retrieveFeedCandidates). Generous on
// purpose: a job no lane returns can never be shown, while hydrating and
// scoring ~4K slim rows costs well under a second (measured on prod).
const FEED_LANE_LIMITS = { role: 3000, skill: 1500, semantic: 300, fresh: 150 } as const;
// Jobs created within this window are always scored (nearest-first), so a new
// posting doesn't have to out-rank 90 days of supply just to be considered.
const FEED_FRESH_HOURS = 72;

/**
 * Retrieval sizing overrides. Production callers never pass these; they exist
 * so scripts/measure-feed-recall.ts can run the same matcher with effectively
 * unbounded lanes as a ground truth for what the bounded lanes miss.
 */
export interface FeedRetrievalOptions {
  laneLimits?: Partial<Record<keyof typeof FEED_LANE_LIMITS, number>>;
  freshHours?: number;
}

export interface FeedFilters {
  jobTitle?: string;
  location?: string;
  workType?: string;
  /** Only jobs first seen within this many days. Applied before the top-100 cut. */
  postedWithinDays?: number;
}

// Escape LIKE/ILIKE wildcards so a term is matched literally (default '\' escape).
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

// The feed's search-UI filters as SQL, shared by the scored feed and its
// discovery fallbacks so a filtered feed never shows rows outside the filter.
// Applied before the 100-job cut: filtering the unfiltered top 100 only ever
// found jobs that were already in it.
function feedFilterConditions(filters?: FeedFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters?.jobTitle) {
    conditions.push(sql`LOWER(${jobPostings.title}) LIKE ${'%' + filters.jobTitle.toLowerCase() + '%'}`);
  }
  if (filters?.location?.trim()) {
    // Same semantics as the feed's city search: case-insensitive substring,
    // so "new york" matches "New York, NY".
    conditions.push(sql`${jobPostings.location} ILIKE ${'%' + escapeLike(filters.location.trim()) + '%'}`);
  }
  if (filters?.workType) {
    // work_type is stored lowercase (classifyWorkType at ingest). Comparing the
    // bare column lets the planner use its stats — behind LOWER() it can't tell
    // that 'onsite' is ~90% of jobs, and drops the HNSW index for a 3x slower plan.
    conditions.push(eq(jobPostings.workType, filters.workType.toLowerCase()));
  }
  if (filters?.postedWithinDays) {
    const postedCutoff = new Date(Date.now() - filters.postedWithinDays * 24 * 60 * 60 * 1000).toISOString();
    conditions.push(sql`${jobPostings.createdAt} > ${postedCutoff}`);
  }
  return conditions;
}

// Job board aggregators — excluded from the candidate feed (links don't go to actual job pages)
const AGGREGATOR_SOURCES = new Set(['Adzuna', 'JSearch', 'Jooble', 'Indeed', 'ArbeitNow', 'USAJobs', 'RemoteOK', 'WeWorkRemotely', 'The Muse']);

// Reposters: they run a REAL ATS board (so source is `ATS:lever` and the URL is
// a genuine jobs.lever.co deep link) but the roles are not their own — they are
// a marketplace or staffing agency relisting other companies' jobs. Every
// structural guard we have says these are direct, which is exactly why they need
// naming: source and URL cannot distinguish them, only knowing the company can.
//
// They are DEMOTED, not deleted — the product promise is that the main dashboard
// shows jobs from the company itself, and anything else appears only when the
// dashboard has nothing. So these are excluded from the matched feed and served
// by the empty-state fallback alongside the aggregators.
//
// Curated deliberately, NOT inferred. A heuristic on description text ("our
// client") flags Accenture Federal Services at 100% — a real employer whose
// consultants genuinely work with clients — and would wrongly bury it. Add a
// company here only after confirming the postings are someone else's roles.
// Landing-page ticker: recognisable employers and the tech roles the launch
// is aimed at. Lowercased to match lower(company).
// Keys are lower(company); values are how the company writes its own name
// (company is often stored lowercased by ingestion).
const JUST_CHECKED_DISPLAY_NAMES: Record<string, string> = {
  'anthropic': 'Anthropic', 'openai': 'OpenAI', 'stripe': 'Stripe', 'databricks': 'Databricks',
  'datadog': 'Datadog', 'anduril industries': 'Anduril Industries', 'waymo': 'Waymo',
  'figma': 'Figma', 'ramp': 'Ramp', 'notion': 'Notion', 'coinbase': 'Coinbase',
  'airbnb': 'Airbnb', 'robinhood': 'Robinhood', 'brex': 'Brex', 'plaid': 'Plaid',
  'doordash usa': 'DoorDash', 'doordash': 'DoorDash',
};
const JUST_CHECKED_COMPANIES = Object.keys(JUST_CHECKED_DISPLAY_NAMES);
const JUST_CHECKED_TITLE_REGEX =
  '\\m(engineer|developer|scientist|machine learning|data|designer|product manager|sre|devops|security)\\M';

// db.execute returns a driver result ({ rows }) or the rows array itself,
// depending on the driver.
function resultRows<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

interface CheckedJobRow {
  title: string; company: string; location: string | null; work_type: string | null;
  external_url: string | null; last_liveness_check: Date | string | null;
}

// Ingestion often stores company lowercased ("roku", "anduril industries").
// Known names get their real spelling; other all-lowercase names are
// title-cased; anything with capitals is left as the company wrote it.
// A job title often spells the name properly ("Front-End Engineer, IXL
// Product" for "ixl learning"), so words found there take its casing.
function displayCompanyName(company: string, titleHint = ''): string {
  const known = JUST_CHECKED_DISPLAY_NAMES[String(company).toLowerCase()];
  if (known) {return known;}
  if (company !== company.toLowerCase()) {return company;}
  const hintWords = new Map(
    (titleHint.match(/\p{L}[\p{L}\d]*/gu) ?? []).map(w => [w.toLowerCase(), w] as [string, string]),
  );
  return company.replace(/\p{L}[\p{L}\d]*/gu, w => {
    const fromTitle = hintWords.get(w);
    return fromTitle && fromTitle !== w ? fromTitle : w.charAt(0).toUpperCase() + w.slice(1);
  });
}

export interface LiveRoleSearch {
  total: number;
  thisWeek: number;
  recentlyChecked: number;
  checkWindowHours: number;
  topCompanies: { company: string; count: number }[];
  postings: {
    title: string; company: string; location: string | null; workType: string | null;
    externalUrl: string | null; lastLivenessCheck: Date | string | null;
  }[];
}

/** Homepage radar: what Recrutas detected on company boards for a role. */
export interface RadarEvent {
  type: 'new' | 'taken_down' | 'reposted';
  at: string;                       // when we detected it
  title: string;
  company: string;
  location: string | null;
  workType: string | null;
  externalUrl: string | null;
  flags: string[];                  // stated hard requirements, e.g. "no sponsorship"
}
export interface MarketRadar {
  scope: 'role' | 'market';         // 'market' when the role had no events this week
  live: number;
  openedThisWeek: number;
  takenDownThisWeek: number;
  medianLifetimeDays: number | null;
  lastBoardRead: string | null;
  events: RadarEvent[];
}

export interface JobUrlCheck {
  verdict: 'live' | 'unverified' | 'taken-down' | 'closed' | 'repost' | 'job-board' | 'not-indexed' | 'invalid';
  host?: string;
  job?: { title: string; company: string; location: string | null; lastSeen: Date | null; postingUrl: string | null };
}

// Aggregators and boards that list jobs rather than host them.
const JOB_BOARD_HOSTS = [
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'monster.com', 'simplyhired.com',
  'dice.com', 'careerbuilder.com', 'wellfound.com', 'builtin.com', 'jooble.org', 'adzuna.com',
  'talent.com', 'jobgether.com', 'google.com', 'hiring.cafe', 'hiringcafe.com', 'otta.com',
];

const REPOSTER_COMPANIES = new Set([
  'jobgether',              // remote-work marketplace relisting other companies' roles
  'nexthire',               // recruiting agency
  'bluelight consulting',   // staffing/outsourcing; 1,138 postings across only 17
                            // distinct titles, and every one uses client language
  'crisp recruit',          // recruiting agency
  'seasoned recruitment',   // recruiting agency
  'talent software services',
  'horizontal talent',
]);
// SQL fragment: keep reposter-owned boards out of the direct feed.
const reposterExclusion = sql`(
  ${jobPostings.company} IS NULL
  OR lower(${jobPostings.company}) NOT IN (${sql.join(
    [...REPOSTER_COMPANIES].map(c => sql`${c}`), sql`, `
  )})
)`;
// Inverse, for the empty-state fallback.
const reposterOnly = sql`lower(${jobPostings.company}) IN (${sql.join(
  [...REPOSTER_COMPANIES].map(c => sql`${c}`), sql`, `
)})`;
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
// Built from server/lib/job-post-url.ts, the same rule ingestion applies.
const jobPostUrlRequirement = sql.raw(jobPostUrlSqlCondition('"job_postings"."external_url"'));

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
      // Never log the profile itself: it holds the full resume text.
      console.log(`[storage] Candidate profile ${profile ? 'found' : 'not found'} for ${userId}`);
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
            // 'failed' is not the only broken state. A résumé that was uploaded
            // but never parsed sits at 'idle' with parsed_at NULL — it never
            // errored, so it was invisible to this retry and stayed unparsed
            // indefinitely (three prod profiles sat that way from 2026-06-16).
            // Treat "has a résumé but no parse result" as retryable too.
            or(
              eq(candidateProfiles.resumeProcessingStatus, 'failed'),
              // A rule-engine fallback that found any skills is saved as
              // 'completed', so it was never retried: every résumé uploaded
              // while the AI providers were down kept rule-engine positions
              // ("Full-stack delivery: building" as a job title) for good.
              sql`(${candidateProfiles.resumeParsingData}->>'degraded') = 'true'
                AND (${candidateProfiles.resumeParsingData}->>'extractor') IN ('rules', 'none')`,
              and(
                sql`${candidateProfiles.parsedAt} IS NULL`,
                or(
                  eq(candidateProfiles.resumeProcessingStatus, 'idle'),
                  sql`${candidateProfiles.resumeProcessingStatus} IS NULL`,
                ),
              ),
            ),
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

  /**
   * Give back an attempt that only failed because the AI providers were out of
   * quota or overloaded. Those clear on their own; counting them would let a few
   * busy hours use up a résumé's retries for good.
   */
  async refundParseAttempt(userId: string): Promise<void> {
    await db.update(candidateProfiles)
      .set({ parseAttempts: sql`GREATEST(COALESCE(${candidateProfiles.parseAttempts}, 0) - 1, 0)` })
      .where(eq(candidateProfiles.userId, userId));
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

  /**
   * A handful of real, recently re-checked US tech roles for the public
   * landing page ticker — one per well-known employer. Uses the same
   * eligibility rules as the feed (direct ATS board, no reposters, real job
   * post URL, explicitly US location, inside the live-badge window).
   */
  async getJustCheckedJobs(limit = 6): Promise<Array<{
    title: string; company: string; location: string | null; workType: string | null;
    externalUrl: string | null; lastLivenessCheck: Date | string | null;
  }>> {
    const rows = await db.execute(sql`
      SELECT * FROM (
        SELECT DISTINCT ON (lower(${jobPostings.company}))
          ${jobPostings.title} AS title,
          ${jobPostings.company} AS company,
          ${jobPostings.location} AS location,
          ${jobPostings.workType} AS work_type,
          ${jobPostings.externalUrl} AS external_url,
          ${jobPostings.lastLivenessCheck} AS last_liveness_check
        FROM ${jobPostings}
        WHERE ${jobPostings.status} = 'active'
          AND ${jobPostings.livenessStatus} = 'active'
          AND ${jobPostings.trustScore} >= 90
          AND ${jobPostings.source} LIKE 'ATS:%'
          AND ${jobPostings.lastLivenessCheck} > now() - make_interval(hours => ${LIVE_BADGE_MAX_AGE_HOURS})
          AND lower(${jobPostings.company}) IN (${sql.join(JUST_CHECKED_COMPANIES.map(c => sql`${c}`), sql`, `)})
          AND ${jobPostings.title} ~* ${JUST_CHECKED_TITLE_REGEX}
          AND ${reposterExclusion}
          AND ${jobPostUrlRequirement}
          AND ${usPriorityOrder} = 0
        ORDER BY lower(${jobPostings.company}), ${jobPostings.lastLivenessCheck} DESC
      ) per_company
      ORDER BY last_liveness_check DESC
      LIMIT ${limit}
    `);
    return resultRows<CheckedJobRow>(rows).map(r => ({
      title: String(r.title).trim(),
      company: displayCompanyName(r.company, String(r.title)),
      location: r.location,
      workType: r.work_type,
      externalUrl: r.external_url,
      lastLivenessCheck: r.last_liveness_check,
    }));
  }


  /**
   * Landing page "what's live for you" search: counts and a few real postings
   * for a role (and optional city / remote) with no résumé and no account.
   * Same eligibility as the feed. The title filter runs first on the trigram
   * index; the expensive US-location check only sees the rows it keeps.
   */
  /**
   * The homepage radar: real events detected on company boards for a role (or
   * the whole market): postings that just opened, were taken down, or came
   * back as reposts. Same US-only, direct-from-company and reposter filters as
   * live search. Looks back 7 days; falls back to the whole market when a
   * narrow role had no events.
   */
  async marketRadar(opts: { words: string[]; location?: string; remoteOnly?: boolean }): Promise<MarketRadar> {
    const likeEsc = (v: string) => v.replace(/[\\%_]/g, c => `\\${c}`);
    const scoped = (words: string[]) => {
      const conds = [sql`source LIKE 'ATS:%'`, ...words.map(w => w.length >= 3
        ? sql`title ILIKE ${'%' + likeEsc(w) + '%'}`
        : sql`title ~* ${'\\m' + w.replace(/[^a-z0-9]/gi, '') + '\\M'}`)];
      if (opts.location) {conds.push(sql`location ILIKE ${'%' + likeEsc(opts.location) + '%'}`);}
      if (opts.remoteOnly) {conds.push(sql`work_type = 'remote'`);}
      return sql.join(conds, sql` AND `);
    };

    const run = async (words: string[]) => resultRows<any>(await db.execute(sql`
      WITH removed60 AS MATERIALIZED (
        SELECT lower(company) AS c, lower(trim(title)) AS t, lower(coalesce(location, '')) AS l, min(created_at) AS first_seen
        FROM job_postings
        WHERE liveness_status = 'removed' AND external_url IS NOT NULL AND updated_at > now() - interval '60 days' AND ${scoped(words)}
        GROUP BY 1, 2, 3
      ),
      opened AS MATERIALIZED (
        SELECT id, title, company, location, work_type, external_url, created_at AS at, description
        FROM job_postings
        WHERE status = 'active' AND created_at > now() - interval '7 days' AND ${scoped(words)}
          AND ${reposterExclusion} AND ${jobPostUrlRequirement} AND ${usPriorityOrder} = 0
        ORDER BY created_at DESC LIMIT 20
      ),
      closed AS MATERIALIZED (
        SELECT title, company, location, work_type, external_url, updated_at AS at
        FROM job_postings
        WHERE liveness_status = 'removed' AND external_url IS NOT NULL AND updated_at > now() - interval '7 days'
          AND ${scoped(words)} AND ${usPriorityOrder} = 0
        ORDER BY updated_at DESC LIMIT 12
      )
      SELECT
        (SELECT count(*)::int FROM job_postings WHERE status = 'active' AND ${scoped(words)} AND ${usPriorityOrder} <> 2) AS live,
        (SELECT count(*)::int FROM job_postings WHERE created_at > now() - interval '7 days' AND ${scoped(words)}) AS opened_week,
        (SELECT count(*)::int FROM job_postings WHERE liveness_status = 'removed' AND external_url IS NOT NULL
           AND updated_at > now() - interval '7 days' AND ${scoped(words)}) AS down_week,
        (SELECT CASE WHEN count(*) >= 20 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (updated_at - created_at)) / 86400) END
           FROM job_postings WHERE liveness_status = 'removed' AND external_url IS NOT NULL
           AND updated_at > now() - interval '60 days' AND ${scoped(words)}) AS median_days,
        (SELECT coalesce(json_agg(o), '[]') FROM (
          SELECT o.*, EXISTS (SELECT 1 FROM removed60 r WHERE r.c = lower(o.company) AND r.t = lower(trim(o.title))
                              AND r.l = lower(coalesce(o.location, '')) AND r.first_seen < o.at) AS reposted
          FROM opened o) o) AS opened,
        (SELECT coalesce(json_agg(c), '[]') FROM closed c) AS closed
    `))[0];

    let words = opts.words;
    let r = await run(words);
    let scope: MarketRadar['scope'] = words.length ? 'role' : 'market';
    if (words.length && (r.opened?.length ?? 0) + (r.closed?.length ?? 0) === 0) {
      words = [];
      r = await run(words);
      scope = 'market';
    }
    const flagsOf = (desc: string): string[] => {
      const h = extractHardRequirements(desc);
      const names: Record<string, string> = { public_trust: 'public trust', secret: 'secret clearance', top_secret: 'top secret', ts_sci: 'TS/SCI' };
      return [
        ...(h.clearance ? [names[h.clearance]] : []),
        ...(h.usCitizen ? ['US citizens only'] : h.usPerson ? ['US person'] : []),
        ...(h.noSponsorship ? ['no sponsorship'] : []),
        ...(h.minYears != null ? [`${h.minYears}+ yrs`] : []),
      ];
    };
    const shape = (e: any, type: RadarEvent['type']): RadarEvent => ({
      type, at: new Date(e.at).toISOString(),
      title: String(e.title).trim(), company: displayCompanyName(e.company, String(e.title)),
      location: e.location, workType: e.work_type, externalUrl: e.external_url,
      flags: type === 'taken_down' ? [] : flagsOf(e.description || ''),
    });
    const events = [
      ...(r.opened ?? []).map((e: any) => shape(e, e.reposted ? 'reposted' : 'new')),
      ...(r.closed ?? []).map((e: any) => shape(e, 'taken_down')),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 24);
    const last = resultRows<any>(await db.execute(sql`SELECT max(last_liveness_check) AS t FROM job_postings WHERE status = 'active'`))[0]?.t;
    return {
      scope, live: r.live ?? 0, openedThisWeek: r.opened_week ?? 0, takenDownThisWeek: r.down_week ?? 0,
      medianLifetimeDays: r.median_days != null ? Math.round(Number(r.median_days)) : null,
      lastBoardRead: last ? new Date(last).toISOString() : null,
      events,
    };
  }

  async searchLiveRoles(opts: { words: string[]; location?: string; remoteOnly?: boolean }): Promise<LiveRoleSearch> {
    const likeEsc = (v: string) => v.replace(/[\\%_]/g, c => `\\${c}`);
    const titleConds = opts.words.map(w => w.length >= 3
      ? sql`title ILIKE ${'%' + likeEsc(w) + '%'}`
      // Short words ("ml", "qa", "ui") would match inside other words.
      : sql`title ~* ${'\\m' + w.replace(/[^a-z0-9]/gi, '') + '\\M'}`);
    const conds = [sql`status = 'active'`, ...titleConds];
    if (opts.location) {conds.push(sql`location ILIKE ${'%' + likeEsc(opts.location) + '%'}`);}
    if (opts.remoteOnly) {conds.push(sql`work_type = 'remote'`);}

    const rows = await db.execute(sql`
      WITH m AS MATERIALIZED (
        SELECT title, company, location, work_type, external_url, source, trust_score,
               liveness_status, last_liveness_check, created_at
        FROM job_postings
        WHERE ${sql.join(conds, sql` AND `)}
      ),
      e AS MATERIALIZED (
        SELECT *, ${usPriorityOrder} AS us_rank FROM m AS job_postings
        WHERE ${reposterExclusion} AND ${jobPostUrlRequirement} AND ${usPriorityOrder} <> 2
      )
      SELECT
        (SELECT count(*)::int FROM e) AS total,
        (SELECT count(*)::int FROM e WHERE created_at > now() - interval '7 days') AS this_week,
        (SELECT count(*)::int FROM e WHERE last_liveness_check > now() - make_interval(hours => ${LIVE_BADGE_MAX_AGE_HOURS})) AS recently_checked,
        (SELECT coalesce(json_agg(t), '[]') FROM (
          SELECT min(company) AS company, count(*)::int AS n FROM e
          GROUP BY lower(company) ORDER BY count(*) DESC, lower(company) LIMIT 5
        ) t) AS top_companies,
        (SELECT coalesce(json_agg(t), '[]') FROM (
          SELECT title, company, location, work_type, external_url, last_liveness_check FROM e
          -- Counts match the feed (unknown locations included); the postings
          -- we show must be explicitly US.
          WHERE us_rank = 0 AND liveness_status = 'active' AND trust_score >= 90 AND source LIKE 'ATS:%'
            AND last_liveness_check > now() - make_interval(hours => ${LIVE_BADGE_MAX_AGE_HOURS})
          ORDER BY created_at DESC LIMIT 6
        ) t) AS postings
    `);
    const r = resultRows<{
      total: number; this_week: number; recently_checked: number;
      top_companies: { company: string; n: number }[] | null;
      postings: CheckedJobRow[] | null;
    }>(rows)[0];
    return {
      total: r?.total ?? 0,
      thisWeek: r?.this_week ?? 0,
      recentlyChecked: r?.recently_checked ?? 0,
      checkWindowHours: LIVE_BADGE_MAX_AGE_HOURS,
      topCompanies: (r?.top_companies ?? []).map(c => ({ company: displayCompanyName(c.company), count: c.n })),
      postings: (r?.postings ?? []).map(j => ({
        title: String(j.title).trim(),
        company: displayCompanyName(j.company, String(j.title)),
        location: j.location,
        workType: j.work_type,
        externalUrl: j.external_url,
        lastLivenessCheck: j.last_liveness_check,
      })),
    };
  }

  /**
   * "Is this job still real?" — look a pasted posting URL up in our index.
   * Database lookup only: the URL is never fetched.
   */
  async checkJobUrl(raw: string): Promise<JobUrlCheck> {
    let url: URL;
    try { url = new URL(raw.trim()); } catch { return { verdict: 'invalid' }; }
    if (!/^https?:$/.test(url.protocol)) {return { verdict: 'invalid' };}
    const host = url.hostname.toLowerCase().replace(/^www\./, '');

    // Exact spellings first (indexed): as pasted, without tracking params or
    // fragment, and with / without a trailing slash.
    const cleaned = new URL(url.toString());
    cleaned.hash = '';
    for (const k of [...cleaned.searchParams.keys()]) {
      if (/^(utm_|ref|source|src|lever-|gh_src|trk)/i.test(k)) {cleaned.searchParams.delete(k);}
    }
    const variants = new Set<string>();
    for (const u of [raw.trim(), url.toString(), cleaned.toString()]) {
      variants.add(u);
      variants.add(u.endsWith('/') ? u.slice(0, -1) : `${u}/`);
    }
    const cols = {
      title: jobPostings.title, company: jobPostings.company, location: jobPostings.location,
      status: jobPostings.status, livenessStatus: jobPostings.livenessStatus,
      lastLivenessCheck: jobPostings.lastLivenessCheck, source: jobPostings.source,
      externalUrl: jobPostings.externalUrl,
    };
    let [row] = await db.select(cols).from(jobPostings)
      .where(inArray(jobPostings.externalUrl, [...variants])).limit(1);

    // Fallback: the same posting under another URL shape, matched on its
    // job id (a long number or a UUID). Unindexed, so only on a miss.
    if (!row) {
      const id = (url.pathname + url.search).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]
        ?? (url.pathname + url.search).match(/\d{6,}/g)?.sort((a, b) => b.length - a.length)[0];
      if (id) {
        [row] = await db.select(cols).from(jobPostings)
          .where(sql`${jobPostings.externalUrl} LIKE ${'%' + id + '%'}`)
          .orderBy(desc(jobPostings.lastLivenessCheck)).limit(1);
      }
    }

    if (!row) {
      return { verdict: JOB_BOARD_HOSTS.some(h => host === h || host.endsWith(`.${h}`)) ? 'job-board' : 'not-indexed', host };
    }
    const job = {
      title: String(row.title).trim(),
      company: displayCompanyName(row.company, String(row.title)),
      location: row.location,
      lastSeen: row.lastLivenessCheck,
      postingUrl: row.externalUrl,
    };
    if (REPOSTER_COMPANIES.has(String(row.company).toLowerCase())) {return { verdict: 'repost', job };}
    if (row.status === 'active') {
      const hours = row.lastLivenessCheck ? (Date.now() - new Date(row.lastLivenessCheck).getTime()) / 3_600_000 : Infinity;
      return { verdict: hours <= LIVE_BADGE_MAX_AGE_HOURS && row.livenessStatus === 'active' ? 'live' : 'unverified', job };
    }
    return { verdict: row.livenessStatus === 'removed' ? 'taken-down' : 'closed', job };
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
        // Exclude reposters (marketplaces/agencies on a real ATS board) — they
        // pass every source and URL check but the job is not theirs.
        reposterExclusion,
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

      // Query external jobs (source = 'external' or externalUrl is set).
      // Skip the two embedding columns — the feed renders title/company/location
      // and nothing downstream of this call reads them, but SELECT * shipped
      // them all the way to the browser (a 384-dim vector per row was ~25% of
      // the /api/external-jobs response body).
      const { embedding: _omitEmbedding, vectorEmbedding: _omitVectorEmbedding, ...slimColumns } =
        getTableColumns(jobPostings);

      const query = db
        .select(slimColumns)
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
      // No skill or title signal → nothing to relevance-match against. Return
      // empty rather than padding the empty state with recency-only noise (which
      // is just random aggregator jobs the candidate has no demonstrated fit for).
      if (skills.length === 0 && !filters.jobTitle?.trim()) {
        return [];
      }

      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const cutoffDateStr = ninetyDaysAgo.toISOString();

      // Rank by how many of the candidate's skills actually match, then by recency.
      //
      // NULL (not `sql`0``) when there are no skills: a bare integer literal in
      // ORDER BY is a COLUMN POSITION in Postgres, so `ORDER BY 0 DESC` fails
      // with "ORDER BY position 0 is not in select list". That threw on every
      // title-only search, and the catch below turned it into an empty result —
      // so a candidate with no parsed skills yet (i.e. every brand-new signup)
      // who searched by job title silently got nothing back.
      const skillMatchExpr = skills.length > 0
        ? sql`(${sql.join(
            skills.map(skill =>
              sql`(CASE WHEN LOWER(${jobPostings.title}) LIKE LOWER(${'%' + skill + '%'}) OR LOWER(${jobPostings.skills}::text) LIKE LOWER(${'%' + skill + '%'}) THEN 1 ELSE 0 END)`
            ),
            sql` + `
          )})`
        : null;

      const baseConditions = (): any[] => [
        eq(jobPostings.status, 'active'),
        // Aggregator-sourced OR reposter-owned: both are "not from the company
        // itself", so both belong here — visible only when the main dashboard
        // has nothing to show.
        or(
          sql`${jobPostings.source} IN (${sql.join(
            [...AGGREGATOR_SOURCES].map(s => sql`${s}`), sql`, `
          )})`,
          reposterOnly,
        ),
        sql`${jobPostings.externalUrl} IS NOT NULL`,
        // Aggregators are served with their native redirect/apply URLs (no
        // resolution). Native aggregator redirects click through to the real
        // post, but bare-domain homepage roots (e.g. https://christushealth.org)
        // — left behind by the now-retired Adzuna URL resolver — are dead links.
        // Drop them so the mixed-aggregator fallback only serves working URLs.
        sql`NOT (${jobPostings.externalUrl} ~ '^https?://[^/]+/?$')`,
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
          .orderBy(
            skillMatchExpr
              ? sql`${skillMatchExpr} DESC, ${jobPostings.createdAt} DESC`
              : sql`${jobPostings.createdAt} DESC`,
          )
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
    relevance?: { skills?: string[]; roleKeywords?: string[]; relevantOnly?: boolean },
    filterWhere: SQL[] = [],
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
        ...filterWhere,
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
      // Title matches sort first (0), skill-only matches after (1). Within
      // each, more shared skills first: one overlapping skill is all `?|`
      // requires, and ordered by recency alone that put a home-health nurse
      // role at the top of a software engineer's feed (2026-10-03).
      const overlapCount = relevantSkills.length > 0
        ? sql`(${sql.join(relevantSkills.slice(0, 40).map(s => sql`(${jobPostings.skills} ? ${s})::int`), sql` + `)})`
        : undefined;
      const relevanceOrder = [
        ...(titleMatch ? [sql`CASE WHEN ${titleMatch} THEN 0 ELSE 1 END`] : []),
        ...(overlapCount ? [sql`${overlapCount} DESC NULLS LAST`] : []),
      ];
      discoveryJobs = await runQuery(
        [relevanceWhere.length > 1 ? or(...relevanceWhere) : relevanceWhere[0]],
        relevanceOrder,
      );
    }
    // When relevantOnly, do NOT fall through to generic recent roles. Returning
    // empty lets /api/ai-matches report zero, which restores the original
    // zero-result → client aggregator-fallback behaviour (the generic feed had
    // been shadowing it). Non-relevance callers (no profile, timeout safety net)
    // still get the generic fill so their screen is never empty.
    if (discoveryJobs.length === 0 && !relevance?.relevantOnly) {
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
        isVerifiedActive: isRecentlyVerifiedLive(job),
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

  private async fetchScoredJobs(candidateId: string, filters?: FeedFilters, retrieval?: FeedRetrievalOptions): Promise<any[] | null> {
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
      return this.getDiscoveryFeed(excludeIds, 'Upload your resume to get personalized matches', undefined, feedFilterConditions(filters));
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
      return this.getDiscoveryFeed(excludeIds, "We couldn't recognize specific skills from your resume. Here are recent roles to explore.", undefined, feedFilterConditions(filters));
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

    const extraFilters = feedFilterConditions(filters);

    // ── Retrieval ─────────────────────────────────────────────────
    const titleMatchSkills = candidateSkills.filter(s => s.length >= 4);
    const roleTitleKeywords = getRoleTitleKeywords(candidateTitles);
    if (roleTitleKeywords.length > 0) {
      console.log(`Role title keywords: ${roleTitleKeywords.join(', ')}`);
    }

    // Cheap column checks, split out so the big retrieval lanes can rank on
    // them first and run the regex-heavy checks below on a short list only.
    const coreEligibility = and(
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
      ...extraFilters,
    );
    // Shared by every retrieval lane (see retrieveFeedCandidates), so a job's
    // eligibility can't depend on which lane happened to find it.
    const baseFilters = and(
      coreEligibility,
      // Reposters run a real ATS board, so source/URL checks all pass — only the
      // company name identifies them.
      reposterExclusion,
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
    );

    console.time('retrieval');
    const retrieved = await this.retrieveFeedCandidates({
      baseFilters,
      coreEligibility,
      vectorStr: candidateEmbedding && candidateEmbedding.length > 0 ? `[${candidateEmbedding.join(',')}]` : undefined,
      candidateSkills,
      titleMatchSkills,
      roleTitleKeywords,
      retrieval,
    });
    console.timeEnd('retrieval');

    const vectorDistMap = new Map<number, number>();
    for (const [id, dist] of retrieved) {
      if (dist !== undefined) vectorDistMap.set(id, dist);
    }

    // Scoring hydrate. Retrieval now hands over a few thousand ids, so this
    // projection skips everything scoreJob doesn't read: both embedding columns
    // (distances are precomputed per lane) and requirements. description
    // averages ~6KB and scoreJob only reads it to extract skills from jobs that
    // have none tagged, so it is fetched for those rows alone. The returned
    // jobs get their full text in one small query at the end.
    const {
      embedding: _omitEmbedding,
      vectorEmbedding: _omitVectorEmbedding,
      description: _omitDescription,
      requirements: _omitRequirements,
      ...scoringColumns
    } = getTableColumns(jobPostings);

    let allJobs: any[] = [];
    if (retrieved.size > 0) {
      console.time('hydrate-query');
      allJobs = await db
        .select({
          ...scoringColumns,
          description: sql<string | null>`CASE WHEN jsonb_typeof(${jobPostings.skills}) = 'array'
            THEN (CASE WHEN jsonb_array_length(${jobPostings.skills}) > 0 THEN NULL ELSE ${jobPostings.description} END)
            ELSE ${jobPostings.description} END`,
        })
        .from(jobPostings)
        .where(inArray(jobPostings.id, [...retrieved.keys()]));
      console.timeEnd('hydrate-query');
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
          isVerifiedActive: isRecentlyVerifiedLive(job),
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

      let finalJobs = recommendations
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

    // De-duplicate by external URL. The same real posting can be ingested as
    // multiple rows (e.g. company name captured under different casing —
    // "Carta" vs "carta"), which surfaces the identical job twice in the feed.
    // finalJobs is already best-ranked first, so keeping the first occurrence
    // per URL keeps the highest-scored copy. Dedup ONLY by URL: distinct
    // postings that share a company+title but have different URLs (two real
    // reqs) are legitimately separate and must not be collapsed. Platform jobs
    // have no external_url and are never merged.
    const seenJobUrls = new Set<string>();
    const beforeDedup = finalJobs.length;
    finalJobs = finalJobs.filter(job => {
      const raw = job.externalUrl;
      if (!raw) return true; // platform/no-URL rows are always kept
      const key = raw.trim().toLowerCase().replace(/#.*$/, '').replace(/\/+$/, '');
      if (!key) return true;
      if (seenJobUrls.has(key)) return false;
      seenJobUrls.add(key);
      return true;
    });
    if (finalJobs.length !== beforeDedup) {
      console.log(`[fetchScoredJobs] deduped ${beforeDedup - finalJobs.length} same-URL duplicate(s) → ${finalJobs.length} jobs`);
    }

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
      console.log(`[fetchScoredJobs] 0 jobs cleared the 30% floor — falling back to relevant discovery (else empty → aggregator)`);
      return this.getDiscoveryFeed(excludeIds, 'Here are recent roles to explore while we tune your matches', { skills: candidateSkills, roleKeywords: roleTitleKeywords, relevantOnly: true }, extraFilters);
    }

    // Full text for the jobs actually returned (the scoring hydrate skipped it).
    const textRows = await db
      .select({ id: jobPostings.id, description: jobPostings.description, requirements: jobPostings.requirements })
      .from(jobPostings)
      .where(inArray(jobPostings.id, finalJobs.map(job => job.id)));
    const textById = new Map(textRows.map(row => [row.id, row]));

    return finalJobs.map(({ prefBoost: _p, compositeScore: _c, ...job }) => {
      const text = textById.get(job.id);
      return {
        ...job,
        description: text?.description ?? null,
        requirements: Array.isArray(text?.requirements) ? text.requirements : [],
      };
    });
  }

  /**
   * Candidate generation for the matched feed: decides which jobs get scored.
   *
   * Recall is the whole job here. A job no lane returns is never scored, so it
   * can't reach the feed however well it fits. The previous version took an
   * UNORDERED `LIMIT 1000` of keyword matches (a candidate listing
   * "Communication" or "Git" matched ~38K jobs, so the 1000 were effectively
   * arbitrary) plus an ANN top-100 that post-filtering cut to 58. Measured
   * 2026-09-27 on a real candidate: the feed held 10 of their true top-100 and
   * none of the 80 better-fitting jobs posted in the previous 48h.
   *
   * So every lane is ordered by a signal the scorer itself rewards, never by
   * physical row order, and every lane shares baseFilters:
   *   role     — title in the candidate's role family, nearest embedding first
   *   skill    — skill overlap, highest share of the job's skills first
   *   semantic — nearest embeddings over the whole eligible pool
   *   fresh    — nearest jobs from the last FEED_FRESH_HOURS, so a new posting
   *              is always scored instead of having to win a global cut first
   *
   * Returns job id → cosine distance (undefined when either side has no
   * embedding).
   */
  private async retrieveFeedCandidates(opts: {
    baseFilters: SQL | undefined;
    /** The cheap subset of baseFilters (no regexes), for pre-ranking big lanes. */
    coreEligibility: SQL | undefined;
    vectorStr?: string;
    candidateSkills: string[];
    titleMatchSkills: string[];
    roleTitleKeywords: string[];
    retrieval?: FeedRetrievalOptions;
  }): Promise<Map<number, number | undefined>> {
    const { baseFilters, coreEligibility, vectorStr, candidateSkills, titleMatchSkills, roleTitleKeywords } = opts;
    const limits = { ...FEED_LANE_LIMITS, ...opts.retrieval?.laneLimits };
    const freshHours = opts.retrieval?.freshHours ?? FEED_FRESH_HOURS;

    const dist = vectorStr ? sql<number>`(${jobPostings.embedding} <=> ${vectorStr}::vector)` : undefined;
    // `+ 0` stops the planner from serving this ORDER BY through the HNSW
    // index. The role and fresh lanes filter hard (title / last 72h), and an
    // index scan applies that filter AFTER the approximate search, returning a
    // handful of rows. An exact sort over the already-filtered rows is ~1s.
    const exactDistOrder = dist ? sql`${dist} + 0` : undefined;

    const titleContains = (terms: string[]) =>
      terms.map(term => sql`${jobPostings.title} ILIKE ${'%' + escapeLike(term) + '%'}`);
    const skillArray = sql`ARRAY[${sql.join(candidateSkills.map(s => sql`${s}`), sql`, `)}]::text[]`;
    // GIN-indexed (idx_job_postings_skills_gin). Candidate and job skills both
    // pass through normalizeSkill(), so they share canonical case.
    const skillMatch = candidateSkills.length > 0 ? sql`${jobPostings.skills} ?| ${skillArray}` : undefined;
    const keywordMatch = or(skillMatch, ...titleContains(titleMatchSkills));
    const roleMatch = roleTitleKeywords.length > 0 ? or(...titleContains(roleTitleKeywords)) : undefined;
    // Mirrors scoreJob's keyword score: matched skills / max(job skills, 3).
    // One `?` test per skill is ~2-3x faster than unnesting the array.
    const skillShare = candidateSkills.length > 0
      ? sql`CASE WHEN jsonb_typeof(${jobPostings.skills}) = 'array' THEN
          (${sql.join(candidateSkills.map(s => sql`(${jobPostings.skills} ? ${s})::int`), sql` + `)})::float
            / GREATEST(jsonb_array_length(${jobPostings.skills}), 3)
          ELSE 0 END`
      : sql`0`;
    const keywordOrder = [sql`${skillShare} DESC`, desc(jobPostings.createdAt)];
    // Skill overlap alone is a weak proxy: a candidate listing "Git" or
    // "Communication" overlaps ~40K jobs, and many of their best matches share
    // a small fraction of a long skill list. With an embedding, rank the skill
    // lane on the scorer's own two heaviest terms instead — 0.35 x semantic
    // (same normalisation as scoreJob) + 0.25 x skill share. Measured on every
    // candidate with skills: 100% of true >=75 matches retrieved, 91% of >=60.
    const skillLaneOrder = dist
      ? [sql`(0.35 * LEAST(1, GREATEST(0, ((1 - ${dist}) - 0.3) / 0.5)) + 0.25 * LEAST(1, ${skillShare})) DESC`, desc(jobPostings.createdAt)]
      : keywordOrder;
    const freshCutoff = new Date(Date.now() - freshHours * 60 * 60 * 1000).toISOString();
    const idAndDist = { id: jobPostings.id, dist: dist ?? sql<null>`NULL` };

    const startedAt = Date.now();
    const timed = (name: string, query: Promise<{ id: number; dist: number | null }[]>) =>
      query.then(rows => ({ name, rows, ms: Date.now() - startedAt }));
    const lane = (name: string, where: SQL | undefined, orderBy: SQL[], limit: number) =>
      timed(name, db.select(idAndDist)
        .from(jobPostings)
        .where(and(baseFilters, where))
        .orderBy(...orderBy)
        .limit(limit));

    const lanes: Promise<{ name: string; rows: { id: number; dist: number | null }[]; ms: number }>[] = [];
    if (roleMatch) {
      lanes.push(lane('role', roleMatch, exactDistOrder ? [exactDistOrder] : keywordOrder, limits.role));
    }
    if (keywordMatch) {
      // This lane can match tens of thousands of rows, and baseFilters' regex
      // checks (non-US location, job-post URL) cost ~4s at that size. Rank on
      // the cheap checks first, keep a 3x short list, then apply the full
      // filters to that list only (most rows pass them).
      const shortList = db.select({ id: jobPostings.id })
        .from(jobPostings)
        .where(and(coreEligibility, keywordMatch))
        .orderBy(...skillLaneOrder)
        .limit(limits.skill * 3);
      lanes.push(lane('skill', inArray(jobPostings.id, shortList), skillLaneOrder, limits.skill));
    }
    if (dist) {
      lanes.push(timed('semantic', db.transaction(async (tx) => {
        // SET LOCAL needs a transaction so both statements share one backend.
        // Without iterative scan, the index returns its ef_search nearest rows
        // and THEN applies the WHERE, so a 300-row request came back with
        // 58-108. relaxed_order keeps walking the graph until LIMIT rows pass
        // (bounded by hnsw.max_scan_tuples); measured ~20ms on prod.
        await tx.execute(sql`SET LOCAL hnsw.ef_search = 200`);
        await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
        return tx.select(idAndDist)
          .from(jobPostings)
          .where(and(baseFilters, isNotNull(jobPostings.embedding)))
          .orderBy(dist)
          .limit(limits.semantic);
      })));
    }
    // Without an embedding the scorer caps no-overlap jobs at 25%, so fresh
    // jobs are only worth scoring when they share a skill or role title.
    const freshRelevance = dist ? isNotNull(jobPostings.embedding) : or(keywordMatch, roleMatch);
    if (freshRelevance) {
      lanes.push(lane(
        'fresh',
        and(sql`${jobPostings.createdAt} > ${freshCutoff}`, freshRelevance),
        exactDistOrder ? [exactDistOrder] : keywordOrder,
        limits.fresh,
      ));
    }

    const results = await Promise.all(lanes);
    const retrieved = new Map<number, number | undefined>();
    for (const { rows } of results) {
      for (const row of rows) {
        const d = row.dist == null ? undefined : Number(row.dist);
        retrieved.set(Number(row.id), d);
      }
    }
    console.log(`[retrieval] ${results.map(r => `${r.name}=${r.rows.length}/${r.ms}ms`).join(' ')} → ${retrieved.size} unique`);
    return retrieved;
  }

  /**
   * Get job recommendations with server-side pagination.
   */
  async getJobRecommendations(
    candidateId: string,
    filters?: FeedFilters,
    pagination?: { page: number; limit: number },
    retrieval?: FeedRetrievalOptions,
  ): Promise<{ jobs: any[]; total: number; page: number; hasMore: boolean }> {
    try {
      const recommendations = await this.fetchScoredJobs(candidateId, filters, retrieval);
      if (!recommendations || recommendations.length === 0) {
        return { jobs: [], total: 0, page: 1, hasMore: false };
      }

      const page = pagination?.page ?? 1;
      const limit = pagination?.limit ?? 20;
      const offset = (page - 1) * limit;
      const total = recommendations.length;
      const jobs = await this.attachVerdicts(candidateId, recommendations.slice(offset, offset + limit));

      console.log(`Returning page ${page}: ${jobs.length} of ${total} job recommendations`);
      return { jobs, total, page, hasMore: offset + limit < total };
    } catch (error) {
      console.error('Error fetching job recommendations:', error);
      throw error;
    }
  }

  /**
   * Apply / Stretch / Skip for one page of the feed. Scoring deliberately
   * doesn't load full descriptions (they're the heaviest column), so the hard
   * requirements are read here for the returned page only. Within the page,
   * Skip moves to the end; nothing is hidden. Never fails the feed: on any
   * error the page goes out without verdicts.
   */
  private async attachVerdicts(candidateId: string, jobs: any[]): Promise<any[]> {
    if (jobs.length === 0) {return jobs;}
    try {
      const startedAt = Date.now();
      const ids = jobs.map(j => j.id).filter((id: unknown) => typeof id === 'number');
      const [candidate, descRows] = await Promise.all([
        this.getCandidateUser(candidateId),
        ids.length ? db.select({ id: jobPostings.id, description: jobPostings.description })
          .from(jobPostings).where(inArray(jobPostings.id, ids)) : Promise.resolve([]),
      ]);
      const descriptions = new Map<number, string>(descRows.map((r: any) => [r.id, r.description || '']));
      const answers = (candidate as any)?.jobPreferences?.applicationAnswers || {};
      const facts: CandidateFacts = {
        usCitizen: answers.usCitizen,
        needsSponsorship: answers.needsSponsorship,
        workAuthorizedUS: answers.workAuthorizedUS,
        securityClearance: answers.securityClearance,
        years: yearsFromPositions((candidate as any)?.resumeParsingData?.positions),
      };
      const withVerdicts = jobs.map(job => ({
        ...job,
        verdict: verdictFor(extractHardRequirements(descriptions.get(job.id) ?? job.description ?? ''), facts, Number(job.matchScore) || 0),
      }));
      const ordered = [
        ...withVerdicts.filter(j => j.verdict.label !== 'skip'),
        ...withVerdicts.filter(j => j.verdict.label === 'skip'),
      ];
      console.log(`[verdicts] ${ordered.length} jobs in ${Date.now() - startedAt}ms: ` +
        ['apply', 'stretch', 'skip'].map(l => `${l} ${ordered.filter(j => j.verdict.label === l).length}`).join(', '));
      return ordered;
    } catch (err) {
      console.error('[verdicts] skipped, feed served without them:', (err as Error).message);
      return jobs;
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
          jp.status AS "jobStatus",
          jp.liveness_status AS "jobLiveness",
          jp.updated_at AS "jobUpdatedAt",
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
          // Whether the employer still lists it. 'taken_down' only when the
          // posting left its board (snapshot expiry), not our own housekeeping.
          postingState: r.jobStatus === 'closed' && r.jobLiveness === 'removed' ? 'taken_down'
            : r.jobStatus === 'active' ? 'live' : 'unknown',
          takenDownAt: r.jobStatus === 'closed' && r.jobLiveness === 'removed' ? r.jobUpdatedAt : null,
        },
        reposted: !!r.metadata?.repostNotifiedAt,
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

  async deleteClosedApplicationsByCandidate(candidateId: string): Promise<number> {
    try {
      const deleted = await db
        .delete(jobApplications)
        .where(and(
          eq(jobApplications.candidateId, candidateId),
          inArray(jobApplications.status, ['rejected', 'withdrawn'] as any)
        ))
        .returning({ id: jobApplications.id });
      return deleted.length;
    } catch (error) {
      console.error('Error deleting closed applications by candidate:', error);
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

  /**
   * Check an invite code WITHOUT writing anything.
   *
   * Validation and redemption are deliberately separate. `invite_code_redemptions`
   * has a FK to `users.id`, and the signup routes call this BEFORE upsertUser —
   * so redeeming here could never insert the redemption row for a genuinely new
   * user. The old combined version incremented used_count, then threw on that FK,
   * then reported the code invalid: every new signup got a 403 AND permanently
   * burned one use of the code. Evidence when found: invite_code_redemptions had
   * zero rows ever, and all 46 users had invite_code_used NULL — the gate had
   * never let anybody through.
   */
  async validateInviteCode(code: string, role: string): Promise<{ valid: boolean; error?: string; invite?: any }> {
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

      return { valid: true, invite };
    } catch (error) {
      console.error('[Storage] Invite code validation error:', error);
      return { valid: false, error: 'Failed to validate invite code' };
    }
  }

  /**
   * Consume one use of an already-validated code. Call AFTER the user row exists.
   * Idempotent (a user who already redeemed anything is a no-op) and transactional,
   * so a failure can never leave a use burned without a redemption record.
   */
  async redeemInviteCode(invite: { id: number }, userId: string): Promise<void> {
    const [existing] = await db
      .select()
      .from(inviteCodeRedemptions)
      .where(eq(inviteCodeRedemptions.userId, userId))
      .limit(1);
    if (existing) return;

    await db.transaction(async (tx) => {
      // Increment in SQL rather than read-then-write so concurrent signups on the
      // same code cannot both write the same value and overshoot max_uses.
      await tx.update(inviteCodes)
        .set({ usedCount: sql`${inviteCodes.usedCount} + 1` })
        .where(eq(inviteCodes.id, invite.id));
      await tx.insert(inviteCodeRedemptions).values({ codeId: invite.id, userId });
    });
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

