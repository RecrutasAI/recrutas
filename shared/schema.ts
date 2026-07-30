import {
  pgTable,
  text,
  varchar,
  timestamp,
  jsonb,
  index,
  serial,
  integer,
  boolean,
  numeric,
} from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core/columns/custom";
import { unique } from "drizzle-orm/pg-core/unique-constraint";
import { uuid } from "drizzle-orm/pg-core/columns/uuid";
import { primaryKey } from "drizzle-orm/pg-core/primary-keys";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { relations } from "drizzle-orm";

// pgvector custom type — stores 1024-dim BGE-M3 embeddings as native vector
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() { return 'vector(384)'; },
  toDriver(value: number[]): string { return `[${value.join(',')}]`; },
  fromDriver(value: string): number[] {
    if (typeof value === 'string') {
      // pgvector returns '[0.1,0.2,...]' format
      return value.replace(/^\[|\]$/g, '').split(',').map(Number);
    }
    return value as unknown as number[];
  },
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  first_name: text("first_name"),
  last_name: text("last_name"),
  phone_number: text("phone_number"),
  profile_image_url: text("profile_image_url"),
  role: text("role"),
  profile_complete: boolean("profile_complete").default(false),
  signup_source: varchar("signup_source", { length: 50 }),   // channel: reddit, hn, twitter, ada, etc.
  invite_code_used: varchar("invite_code_used", { length: 40 }), // which invite code was redeemed
});

export const talentOwnerProfiles = pgTable("talent_owner_profiles", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  jobTitle: text("job_title"),
  companyName: text("company_name"),
  companyWebsite: text("company_website"),
  companySize: text("company_size"),

  industry: text("industry"),
  companyLocation: text("company_location"),
  companyDescription: text("company_description"),
  hiringFor: jsonb("hiring_for"),
  currentHiringRoles: text("current_hiring_roles"),
  hiringTimeline: text("hiring_timeline"),
  hiringBudget: text("hiring_budget"),
  profileComplete: boolean("profile_complete").default(false),
  transparencySettings: jsonb("transparency_settings"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});


// The 'companies' table has been temporarily removed to resolve a migration conflict.

export const candidateProfiles = pgTable("candidate_users", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  email: varchar("email"),
  resumeUrl: text("resume_url"),
  linkedinUrl: text("linkedin_url"),
  githubUrl: text("github_url"),
  portfolioUrl: text("portfolio_url"),
  personalWebsite: text("personal_website"),
  behanceUrl: text("behance_url"),
  dribbbleUrl: text("dribbble_url"),
  stackOverflowUrl: text("stack_overflow_url"),
  mediumUrl: text("medium_url"),
  skills: jsonb("skills").default([] as any),
  experience: text("experience"),
  location: varchar("location"),
  salaryMin: integer("salary_min"),
  salaryMax: integer("salary_max"),
  workType: varchar("work_type", { enum: ["remote", "hybrid", "onsite"] }),
  industry: varchar("industry"),
  bio: text("bio"),
  summary: text("summary"),
  resumeText: text("resume_text"),
  resumeParsingData: jsonb("resume_parsing_data").default({} as any),
  experienceLevel: varchar("experience_level", { enum: ["entry", "mid", "senior", "lead", "executive"] }),
  parsedAt: timestamp("parsed_at"),
  profileStrength: integer("profile_strength").default(0),
  profileViews: integer("profile_views").default(0),
  resumeProcessingStatus: varchar("resume_processing_status", { enum: ["idle", "processing", "completed", "failed"] }).default("idle"),
  parseAttempts: integer("parse_attempts").default(0),
  jobPreferences: jsonb("job_preferences").default({} as any),
  // Pre-computed vector embedding for semantic matching (JSON array, 1024-dim BGE-M3)
  vectorEmbedding: text("vector_embedding"),
  // Native pgvector column for ANN retrieval (populated alongside TEXT column)
  embedding: vector("embedding"),
  embeddingUpdatedAt: timestamp("embedding_updated_at"),
  lastFeedVisit: timestamp("last_feed_visit"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const jobPostings = pgTable("job_postings", {
  id: serial("id").primaryKey(),
  talentOwnerId: uuid("talent_owner_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  hiringManagerId: uuid("hiring_manager_id").references(() => users.id, { onDelete: 'set null' }),
  title: varchar("title").notNull(),
  company: varchar("company").notNull(),
  description: text("description").notNull(),
  requirements: jsonb("requirements").default([] as any),
  skills: jsonb("skills").default([] as any),
  location: varchar("location"),
  salaryMin: integer("salary_min"),
  salaryMax: integer("salary_max"),
  workType: varchar("work_type", { enum: ["remote", "hybrid", "onsite"] }),
  industry: varchar("industry"),
  status: varchar("status", { enum: ["active", "paused", "closed"] }).default("active"),
  source: varchar("source").default("platform"),
  externalId: varchar("external_id"),
  externalUrl: varchar("external_url"),
  careerPageUrl: varchar("career_page_url"),
  companyLogoUrl: varchar("company_logo_url"),
  applicationUrl: varchar("application_url"),
  urgency: varchar("urgency", { enum: ["low", "medium", "high"] }).default("medium"),
  viewCount: integer("view_count").default(0),
  applicationCount: integer("application_count").default(0),
  hasExam: boolean("has_exam").default(true),
  examPassingScore: integer("exam_passing_score").default(70),
  autoRankCandidates: boolean("auto_rank_candidates").default(true),
  maxChatCandidates: integer("max_chat_candidates").default(5),
  expiresAt: timestamp("expires_at"), // Job expiration to prevent applying to old jobs
  // Liveness and trust scoring fields for job quality ranking
  lastLivenessCheck: timestamp("last_liveness_check"),
  livenessStatus: varchar("liveness_status", { enum: ["active", "stale", "unknown"] }).default("unknown"),
  trustScore: integer("trust_score").default(50), // 0-100, internal/platform jobs get 100
  // Ghost job detection fields
  ghostJobScore: integer("ghost_job_score").default(0), // 0-100, higher = more likely ghost job
  ghostJobStatus: varchar("ghost_job_status", { enum: ["clean", "suspicious", "flagged", "confirmed"] }).default("clean"),
  ghostJobReasons: jsonb("ghost_job_reasons").default([] as any), // Array of reasons for flagging
  lastGhostCheck: timestamp("last_ghost_check"), // When ghost detection was last run
  companyVerified: boolean("company_verified").default(false), // Whether company email domain is verified
  recruiterEmailDomain: varchar("recruiter_email_domain"), // For company verification
  // Pre-computed vector embedding for semantic search (stored as JSON array)
  vectorEmbedding: text("vector_embedding"),
  // Native pgvector column for ANN retrieval (populated alongside TEXT column)
  embedding: vector("embedding"),
  embeddingUpdatedAt: timestamp("embedding_updated_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table: any) => ({
  // Unique constraint for external job deduplication
  jobExternalUnique: unique("job_external_unique").on(table.externalId, table.source),
  // Indices for common queries
  idxJobLiveness: index("idx_job_liveness").on(table.livenessStatus, table.expiresAt),
  idxJobTrustScore: index("idx_job_trust_score").on(table.trustScore),
  idxJobTalentOwner: index("idx_job_talent_owner").on(table.talentOwnerId),
  idxJobGhostScore: index("idx_job_ghost_score").on(table.ghostJobScore),
  // Partial index for active external job feed (most frequent query)
  idxJobActiveFeed: index("idx_job_active_feed").on(table.status, table.source, table.createdAt),
  // Supports the cross-source external_url dedup guard in job-ingestion.service
  // (the same posting can arrive under different source labels / external_ids).
  idxJobExternalUrl: index("idx_job_external_url").on(table.externalUrl),
}));

export const jobExams = pgTable("job_exams", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobPostings.id, { onDelete: 'cascade' }),
  title: varchar("title").notNull(),
  description: text("description"),
  timeLimit: integer("time_limit").default(30),
  passingScore: integer("passing_score").default(70),
  isActive: boolean("is_active").default(true),
  questions: jsonb("questions").default([] as any),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const examAttempts = pgTable("exam_attempts", {
  id: serial("id").primaryKey(),
  examId: integer("exam_id").notNull().references(() => jobExams.id, { onDelete: 'cascade' }),
  candidateId: uuid("candidate_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  jobId: integer("job_id").notNull().references(() => jobPostings.id, { onDelete: 'cascade' }),
  score: integer("score"),
  totalQuestions: integer("total_questions"),
  correctAnswers: integer("correct_answers"),
  timeSpent: integer("time_spent"),
  answers: jsonb("answers").default([] as any),
  status: varchar("status", { enum: ["in_progress", "completed", "abandoned"] }).default("in_progress"),
  passedExam: boolean("passed_exam").default(false),
  qualifiedForChat: boolean("qualified_for_chat").default(false),
  ranking: integer("ranking"),
  completedAt: timestamp("completed_at"),
  // 24h response SLA: set to completedAt + 24h when candidate passes
  responseDeadlineAt: timestamp("response_deadline_at"),
  // AI-generated feedback shown to failed candidates immediately after exam
  examFeedback: text("exam_feedback"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const jobMatches = pgTable("job_matches", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobPostings.id, { onDelete: 'cascade' }),
  candidateId: uuid("candidate_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  matchScore: integer("match_score").notNull().default(0),
  confidenceLevel: varchar("confidence_level", { enum: ["low", "medium", "high"] }).default("medium"),
  matchReasons: jsonb("match_reasons").default([] as any),
  skillMatches: jsonb("skill_matches").default([] as any),
  aiExplanation: text("ai_explanation"),
  status: varchar("status", { enum: ["pending", "viewed", "interested", "applied", "rejected"] }).default("pending"),
  userFeedback: integer("user_feedback"),
  feedbackReason: text("feedback_reason"),
  viewedAt: timestamp("viewed_at"),
  appliedAt: timestamp("applied_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const chatRooms = pgTable("chat_rooms", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobPostings.id, { onDelete: 'cascade' }),
  candidateId: uuid("candidate_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  hiringManagerId: uuid("hiring_manager_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  examAttemptId: integer("exam_attempt_id").references(() => examAttempts.id, { onDelete: 'cascade' }),
  status: varchar("status", { enum: ["active", "closed"] }).default("active"),
  candidateRanking: integer("candidate_ranking"),
  accessGrantedAt: timestamp("access_granted_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table: any) => ({
  // Unique constraint to prevent duplicate chat rooms
  chatRoomUnique: unique('chat_room_unique').on(table.jobId, table.candidateId),
  idxChatRoomCandidate: index("idx_chat_room_candidate").on(table.candidateId),
}));

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  chatRoomId: integer("chat_room_id").notNull().references(() => chatRooms.id, { onDelete: 'cascade' }),
  senderId: uuid("sender_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  message: text("message").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const jobApplications = pgTable("job_applications", {
  id: serial("id").primaryKey(),
  candidateId: uuid("candidate_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  jobId: integer("job_id").notNull().references(() => jobPostings.id, { onDelete: 'cascade' }),
  matchId: integer("match_id").references(() => jobMatches.id, { onDelete: 'set null' }),
  status: varchar("status", {
    enum: ["pending_exam", "submitting", "submitted", "viewed", "screening", "interview_scheduled", "interview_completed", "offer", "rejected", "withdrawn"]
  }).default("submitted"),
  appliedAt: timestamp("applied_at").defaultNow(),
  viewedByEmployerAt: timestamp("viewed_by_employer_at"),
  lastStatusUpdate: timestamp("last_status_update").defaultNow(),
  interviewLink: varchar("interview_link"),
  notes: text("notes"),
  autoFilled: boolean("auto_filled").default(false),
  resumeUrl: varchar("resume_url"),
  coverLetter: text("cover_letter"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table: any) => ({
  // Unique constraint to prevent duplicate applications
  jobCandidateUnique: unique('job_candidate_unique').on(table.jobId, table.candidateId),
  idxApplicationCandidate: index("idx_application_candidate").on(table.candidateId),
  idxApplicationStatus: index("idx_application_status").on(table.status),
  idxApplicationJobId: index("idx_application_job_id").on(table.jobId),
}));

export const applicationUpdates = pgTable("application_updates", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id").notNull().references(() => jobApplications.id, { onDelete: 'cascade' }),
  previousStatus: varchar("previous_status"),
  newStatus: varchar("new_status").notNull(),
  message: text("message"),
  updatedBy: text("updated_by"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const applicationEvents = pgTable("application_events", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id").notNull().references(() => jobApplications.id, { onDelete: 'cascade' }),
  eventType: varchar("event_type", {
    enum: ["submitted", "viewed", "screened", "shortlisted", "rejected", "interview_scheduled", "interviewed", "decision_pending", "hired", "archived"]
  }).notNull(),
  actorRole: varchar("actor_role", { enum: ["system", "recruiter", "hiring_manager", "team_member"] }).notNull(),
  actorName: varchar("actor_name"),
  actorTitle: varchar("actor_title"),
  viewDuration: integer("view_duration"),
  candidateScore: integer("candidate_score"),
  candidateRanking: integer("candidate_ranking"),
  totalApplicants: integer("total_applicants"),
  feedback: text("feedback"),
  nextSteps: text("next_steps"),
  competitorProfile: text("competitor_profile"),
  visible: boolean("visible").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const applicationInsights = pgTable("application_insights", {
  id: serial("id").primaryKey(),
  candidateId: uuid("candidate_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  applicationId: integer("application_id").notNull().references(() => jobApplications.id, { onDelete: 'cascade' }),
  strengthsIdentified: jsonb("strengths_identified").default([] as any),
  improvementAreas: jsonb("improvement_areas").default([] as any),
  benchmarkViewTime: integer("benchmark_view_time"),
  actualViewTime: integer("actual_view_time"),
  benchmarkScore: integer("benchmark_score"),
  actualScore: integer("actual_score"),
  similarSuccessfulProfiles: jsonb("similar_successful_users").default([] as any),
  recommendedActions: jsonb("recommended_actions").default([] as any),
  successProbability: integer("success_probability"),
  supportiveMessage: text("supportive_message"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const matchFeedback = pgTable("match_feedback", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  matchId: integer("match_id").notNull().references(() => jobMatches.id, { onDelete: 'cascade' }),
  rating: integer("rating").notNull(),
  feedbackType: varchar("feedback_type", { enum: ["match_quality", "job_relevance", "timing", "requirements"] }),
  comment: text("comment"),
  improvementSuggestions: jsonb("improvement_suggestions").default([] as any),
  createdAt: timestamp("created_at").defaultNow(),
});

export const activityLogs = pgTable("activity_logs", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: varchar("type").notNull(),
  description: text("description").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),

  type: varchar("type", {
    enum: [
      "application_viewed",
      "application_ranked",
      "application_accepted",
      "application_rejected",
      "exam_completed",
      "candidate_message",
      "interview_scheduled",
      "high_score_alert",
      "direct_connection",
      "status_update",
      "new_match",
      "new_application",
      "exam_passed",
      "exam_failed",
      "application_submitted",
      "chat_access_granted"
    ]
  }).notNull(),
  title: varchar("title").notNull(),
  message: text("message").notNull(),
  data: jsonb("data"),
  read: boolean("read").default(false),
  priority: varchar("priority", { enum: ["low", "medium", "high", "urgent"] }).default("medium"),
  relatedJobId: integer("related_job_id").references(() => jobPostings.id, { onDelete: 'cascade' }),
  relatedApplicationId: integer("related_application_id").references(() => jobApplications.id, { onDelete: 'cascade' }),
  relatedMatchId: integer("related_match_id").references(() => jobMatches.id, { onDelete: 'cascade' }),
  createdAt: timestamp("created_at").defaultNow(),
  readAt: timestamp("read_at"),
}, (table: any) => ({
  idxNotificationUser: index("idx_notification_user").on(table.userId),
}));

export const notificationPreferences = pgTable("notification_preferences", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  inAppNotifications: boolean("in_app_notifications").default(true),
  emailNotifications: boolean("email_notifications").default(true),
  pushNotifications: boolean("push_notifications").default(false),
  applicationUpdates: boolean("application_updates").default(true),
  examAlerts: boolean("exam_alerts").default(true),
  messageNotifications: boolean("message_notifications").default(true),
  highPriorityOnly: boolean("high_priority_only").default(false),
  quietHours: jsonb("quiet_hours"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const connectionStatus = pgTable("connection_status", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  isOnline: boolean("is_online").default(false),
  lastSeen: timestamp("last_seen").defaultNow(),
  socketId: varchar("socket_id"),
  deviceInfo: jsonb("device_info"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const interviews = pgTable("interviews", {
  id: serial("id").primaryKey(),
  candidateId: uuid("candidate_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  interviewerId: uuid("interviewer_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  jobId: integer("job_id").notNull().references(() => jobPostings.id, { onDelete: 'cascade' }),
  applicationId: integer("application_id").notNull().references(() => jobApplications.id, { onDelete: 'cascade' }),
  scheduledAt: timestamp("scheduled_at").notNull(),
  duration: integer("duration").notNull(),
  platform: varchar("platform", {
    enum: ["zoom", "meet", "teams", "phone"]
  }).notNull().default("zoom"),
  meetingUrl: text("meeting_url"),
  meetingId: varchar("meeting_id"),
  password: varchar("password"),
  notes: text("notes"),
  status: varchar("status", {
    enum: ["scheduled", "confirmed", "completed", "cancelled", "no_show"]
  }).notNull().default("scheduled"),
  feedback: text("feedback"),
  rating: integer("rating"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const savedJobs = pgTable("saved_jobs", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  jobId: integer("job_id").notNull().references(() => jobPostings.id, { onDelete: 'cascade' }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table: any) => {
  return {
    pk: primaryKey({ columns: [table.userId, table.jobId] }),
  }
});

export const hiddenJobs = pgTable("hidden_jobs", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  jobId: integer("job_id").notNull().references(() => jobPostings.id, { onDelete: 'cascade' }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table: any) => {
  return {
    pk: primaryKey({ columns: [table.userId, table.jobId] }),
  }
});

export const usersRelations = relations(users, ({ one, many }: { one: any; many: any }) => ({
  candidateProfile: one(candidateProfiles, {
    fields: [users.id],
    references: [candidateProfiles.userId],
  }),
  jobPostings: many(jobPostings),
  matches: many(jobMatches),
  chatMessages: many(chatMessages),
  activityLogs: many(activityLogs),
  savedJobs: many(savedJobs),
  hiddenJobs: many(hiddenJobs),
  talentOwnerProfile: one(talentOwnerProfiles, {
    fields: [users.id],
    references: [talentOwnerProfiles.userId],
  }),
}));

export const talentOwnerProfilesRelations = relations(talentOwnerProfiles, ({ one }: { one: any }) => ({
  user: one(users, {
    fields: [talentOwnerProfiles.userId],
    references: [users.id],
  }),
}));


// The 'companiesRelations' has been temporarily removed.

export const candidateProfilesRelations = relations(candidateProfiles, ({ one }: { one: any }) => ({
  user: one(users, {
    fields: [candidateProfiles.userId],
    references: [users.id],
  }),
}));

export const jobPostingsRelations = relations(jobPostings, ({ one, many }: { one: any; many: any }) => ({
  talentOwner: one(users, {
    fields: [jobPostings.talentOwnerId],
    references: [users.id],
  }),
  matches: many(jobMatches),
  applications: many(jobApplications),
  savedBy: many(savedJobs),
  hiddenBy: many(hiddenJobs),
}));

export const jobMatchesRelations = relations(jobMatches, ({ one, many }: { one: any; many: any }) => ({
  job: one(jobPostings, {
    fields: [jobMatches.jobId],
    references: [jobPostings.id],
  }),
  candidate: one(users, {
    fields: [jobMatches.candidateId],
    references: [users.id],
  }),
  chatRoom: one(chatRooms),
}));

export const chatRoomsRelations = relations(chatRooms, ({ one, many }: { one: any; many: any }) => ({
  job: one(jobPostings, {
    fields: [chatRooms.jobId],
    references: [jobPostings.id],
  }),
  candidate: one(users, {
    fields: [chatRooms.candidateId],
    references: [users.id],
  }),
  hiringManager: one(users, {
    fields: [chatRooms.hiringManagerId],
    references: [users.id],
  }),
  messages: many(chatMessages),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }: { one: any }) => ({
  chatRoom: one(chatRooms, {
    fields: [chatMessages.chatRoomId],
    references: [chatRooms.id],
  }),
  sender: one(users, {
    fields: [chatMessages.senderId],
    references: [users.id],
  }),
}));

export const notificationsRelations = relations(notifications, ({ one }: { one: any }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
  relatedJob: one(jobPostings, {
    fields: [notifications.relatedJobId],
    references: [jobPostings.id],
  }),
  relatedApplication: one(jobApplications, {
    fields: [notifications.relatedApplicationId],
    references: [jobApplications.id],
  }),
  relatedMatch: one(jobMatches, {
    fields: [notifications.relatedMatchId],
    references: [jobMatches.id],
  }),
}));

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }: { one: any }) => ({
  user: one(users, {
    fields: [notificationPreferences.userId],
    references: [users.id],
  }),
}));

export const connectionStatusRelations = relations(connectionStatus, ({ one }: { one: any }) => ({
  user: one(users, {
    fields: [connectionStatus.userId],
    references: [users.id],
  }),
}));

export const interviewsRelations = relations(interviews, ({ one }: { one: any }) => ({
  candidate: one(users, {
    fields: [interviews.candidateId],
    references: [users.id],
  }),
  interviewer: one(users, {
    fields: [interviews.interviewerId],
    references: [users.id],
  }),
  job: one(jobPostings, {
    fields: [interviews.jobId],
    references: [jobPostings.id],
  }),
  application: one(jobApplications, {
    fields: [interviews.applicationId],
    references: [jobApplications.id],
  }),
}));

// Screening questions for job applications
export const screeningQuestions = pgTable("screening_questions", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobPostings.id, { onDelete: 'cascade' }),
  question: text("question").notNull(),
  questionType: varchar("question_type", { enum: ["text", "multiple_choice", "yes_no"] }).default("text"),
  options: jsonb("options").default([] as any), // For multiple choice options
  isRequired: boolean("is_required").default(true),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const screeningAnswers = pgTable("screening_answers", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id").notNull().references(() => jobApplications.id, { onDelete: 'cascade' }),
  questionId: integer("question_id").notNull().references(() => screeningQuestions.id, { onDelete: 'cascade' }),
  answer: text("answer"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table: any) => ({
  // Unique constraint to prevent duplicate answers
  answerUnique: unique('answer_unique').on(table.applicationId, table.questionId),
}));

export const screeningQuestionsRelations = relations(screeningQuestions, ({ one, many }: { one: any; many: any }) => ({
  job: one(jobPostings, {
    fields: [screeningQuestions.jobId],
    references: [jobPostings.id],
  }),
  answers: many(screeningAnswers),
}));

export const screeningAnswersRelations = relations(screeningAnswers, ({ one }: { one: any }) => ({
  application: one(jobApplications, {
    fields: [screeningAnswers.applicationId],
    references: [jobApplications.id],
  }),
  question: one(screeningQuestions, {
    fields: [screeningAnswers.questionId],
    references: [screeningQuestions.id],
  }),
}));

export const savedJobsRelations = relations(savedJobs, ({ one }: { one: any }) => ({
  user: one(users, {
    fields: [savedJobs.userId],
    references: [users.id],
  }),
  job: one(jobPostings, {
    fields: [savedJobs.jobId],
    references: [jobPostings.id],
  }),
}));

export const hiddenJobsRelations = relations(hiddenJobs, ({ one }: { one: any }) => ({
  user: one(users, {
    fields: [hiddenJobs.userId],
    references: [users.id],
  }),
  job: one(jobPostings, {
    fields: [hiddenJobs.jobId],
    references: [jobPostings.id],
  }),
}));

// ==========================================
// SUBSCRIPTION & PAYMENT TABLES (Stripe)
// ==========================================

export const subscriptionTiers = pgTable("subscription_tiers", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 50 }).notNull().unique(),
  type: varchar("type", { enum: ["candidate", "talent_owner"] }).notNull(),
  priceMonthly: integer("price_monthly").notNull(), // In cents
  priceYearly: integer("price_yearly"),
  features: jsonb("features").default([]),
  limits: jsonb("limits").default({}), // e.g., { "aiMatches": 10, "activeJobs": 3 }
  stripePriceIdMonthly: varchar("stripe_price_id_monthly"),
  stripePriceIdYearly: varchar("stripe_price_id_yearly"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const userSubscriptions = pgTable("user_subscriptions", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  tierId: integer("tier_id").references(() => subscriptionTiers.id, { onDelete: 'set null' }),
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  status: varchar("status", {
    enum: ["active", "canceled", "past_due", "trialing", "incomplete", "free"]
  }).default("free"),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const usageTracking = pgTable("usage_tracking", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  featureType: varchar("feature_type", {
    enum: ["ai_match", "job_post", "resume_enhancement", "candidate_ranking", "analytics"]
  }).notNull(),
  usageCount: integer("usage_count").default(0),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const subscriptionTiersRelations = relations(subscriptionTiers, ({ many }: { many: any }) => ({
  subscriptions: many(userSubscriptions),
}));

export const userSubscriptionsRelations = relations(userSubscriptions, ({ one }: { one: any }) => ({
  user: one(users, {
    fields: [userSubscriptions.userId],
    references: [users.id],
  }),
  tier: one(subscriptionTiers, {
    fields: [userSubscriptions.tierId],
    references: [subscriptionTiers.id],
  }),
}));

export const usageTrackingRelations = relations(usageTracking, ({ one }: { one: any }) => ({
  user: one(users, {
    fields: [usageTracking.userId],
    references: [users.id],
  }),
}));

// ==========================================
// INSERT SCHEMAS
// ==========================================

export const insertUserSchema = createInsertSchema(users);
export const insertCandidateProfileSchema = createInsertSchema(candidateProfiles);
export const insertTalentOwnerProfileSchema = createInsertSchema(talentOwnerProfiles);
export const insertJobPostingSchema = createInsertSchema(jobPostings);

// Update schema for job postings - all updatable fields are optional
export const updateJobPostingSchema = z.object({
  title: z.string().optional(),
  company: z.string().optional(),
  description: z.string().optional(),
  requirements: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  location: z.string().optional().nullable(),
  salaryMin: z.number().optional().nullable(),
  salaryMax: z.number().optional().nullable(),
  workType: z.enum(["remote", "hybrid", "onsite"]).optional().nullable(),
  industry: z.string().optional().nullable(),
  status: z.enum(["active", "paused", "closed"]).optional(),
  hiringManagerId: z.string().uuid().optional().nullable(),
  externalUrl: z.string().optional().nullable(),
  careerPageUrl: z.string().optional().nullable(),
  companyLogoUrl: z.string().optional().nullable(),
  applicationUrl: z.string().optional().nullable(),
  urgency: z.enum(["low", "medium", "high"]).optional(),
  hasExam: z.boolean().optional(),
  examPassingScore: z.number().optional(),
  autoRankCandidates: z.boolean().optional(),
  maxChatCandidates: z.number().optional(),
  expiresAt: z.coerce.date().optional().nullable(),
});

export const insertJobMatchSchema = createInsertSchema(jobMatches);
export const insertChatMessageSchema = createInsertSchema(chatMessages);
export const insertNotificationSchema = createInsertSchema(notifications);
export const insertNotificationPreferencesSchema = createInsertSchema(notificationPreferences);
export const insertInterviewSchema = createInsertSchema(interviews);
export const insertConnectionStatusSchema = createInsertSchema(connectionStatus);
export const insertSubscriptionTierSchema = createInsertSchema(subscriptionTiers);
export const insertUserSubscriptionSchema = createInsertSchema(userSubscriptions);
export const insertUsageTrackingSchema = createInsertSchema(usageTracking);

// Validation schema for interview scheduling
export const scheduleInterviewSchema = z.object({
  candidateId: z.string().uuid(),
  jobId: z.number().int().positive(),
  applicationId: z.number().int().positive(),
  scheduledAt: z.coerce.date().refine(d => d > new Date(), { message: "Interview must be scheduled in the future" }),
  duration: z.number().int().min(15).max(480).optional(),
  platform: z.string().optional(),
  meetingLink: z.string().url().optional().or(z.literal("")),
  notes: z.string().optional(),
});

// Validation schema for talent owner profile completion
export const completeTalentOwnerProfileSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  phoneNumber: z.string().optional(),
  jobTitle: z.string().min(1, "Job title is required"),
  companyName: z.string().min(1, "Company name is required"),
  industry: z.string().min(1, "Industry is required"),
  companyLocation: z.string().min(1, "Company location is required"),
  companyWebsite: z.string().url().optional().or(z.literal("")),
  companySize: z.enum(["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001+"]).optional(),
  companyDescription: z.string().max(2000).optional(),
});

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
export type CandidateProfile = typeof candidateProfiles.$inferSelect;
export type InsertCandidateProfile = z.infer<typeof insertCandidateProfileSchema>;
export type JobPosting = typeof jobPostings.$inferSelect;
export type InsertJobPosting = z.infer<typeof insertJobPostingSchema>;
export type JobMatch = typeof jobMatches.$inferSelect;
export type InsertJobMatch = z.infer<typeof insertJobMatchSchema>;
export type ChatRoom = typeof chatRooms.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type JobApplication = typeof jobApplications.$inferSelect;
export type ApplicationUpdate = typeof applicationUpdates.$inferSelect;
export type MatchFeedback = typeof matchFeedback.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type NotificationPreferences = typeof notificationPreferences.$inferSelect;
export type InsertNotificationPreferences = z.infer<typeof insertNotificationPreferencesSchema>;
export type ConnectionStatus = typeof connectionStatus.$inferSelect;
export type InsertConnectionStatus = z.infer<typeof insertConnectionStatusSchema>;
export type TalentOwnerProfile = typeof talentOwnerProfiles.$inferSelect;
export type InsertTalentOwnerProfile = z.infer<typeof insertTalentOwnerProfileSchema>;
export type SubscriptionTier = typeof subscriptionTiers.$inferSelect;
export type InsertSubscriptionTier = z.infer<typeof insertSubscriptionTierSchema>;
export type UserSubscription = typeof userSubscriptions.$inferSelect;
export type InsertUserSubscription = z.infer<typeof insertUserSubscriptionSchema>;
export type UsageTracking = typeof usageTracking.$inferSelect;
export type InsertUsageTracking = z.infer<typeof insertUsageTrackingSchema>;
// ── Early Access: invite codes ────────────────────────────────────────────────
// Invite-only signup gate. Codes are created by admin, each usable once (or
// multi-use with a maxUses cap). Verified server-side during /api/auth/sync.

export const inviteCodes = pgTable("invite_codes", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 40 }).notNull().unique(),
  description: text("description"),                         // e.g. "Ada Dev Academy batch 3"
  role: varchar("role", { enum: ["candidate", "talent_owner", "any"] }).default("any"),
  maxUses: integer("max_uses").default(1),                  // -1 = unlimited
  usedCount: integer("used_count").default(0).notNull(),
  createdBy: varchar("created_by", { length: 100 }),        // admin name or system
  expiresAt: timestamp("expires_at"),                       // null = never expires
  createdAt: timestamp("created_at").defaultNow(),
}, (table: any) => ({
  idxInviteCode: index("idx_invite_code").on(table.code),
}));

export const inviteCodeRedemptions = pgTable("invite_code_redemptions", {
  id: serial("id").primaryKey(),
  codeId: integer("code_id").notNull().references(() => inviteCodes.id, { onDelete: 'cascade' }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  redeemedAt: timestamp("redeemed_at").defaultNow(),
}, (table: any) => ({
  idxRedemptionUser: index("idx_redemption_user").on(table.userId),
  uniqRedemption: index("idx_redemption_unique").on(table.codeId, table.userId),
}));

export type InviteCode = typeof inviteCodes.$inferSelect;
export type InviteCodeRedemption = typeof inviteCodeRedemptions.$inferSelect;

// ── Early Access: waitlist ────────────────────────────────────────────────────
// Collects emails from people who want early access but don't have an invite code yet.

export const waitlistEntries = pgTable("waitlist_entries", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  firstName: varchar("first_name", { length: 100 }),
  lastName: varchar("last_name", { length: 100 }),
  source: varchar("source", { length: 50 }),          // e.g. "landing", "reddit", "twitter"
  status: varchar("status", { length: 20 }).default("pending").notNull(), // pending, invited, joined
  inviteCodeSent: varchar("invite_code_sent", { length: 40 }), // code sent to them (if any)
  createdAt: timestamp("created_at").defaultNow(),
}, (table: any) => ({
  idxWaitlistEmail: index("idx_waitlist_email").on(table.email),
  idxWaitlistStatus: index("idx_waitlist_status").on(table.status),
}));

export type WaitlistEntry = typeof waitlistEntries.$inferSelect;

// ── Per-user daily rate limits ───────────────────────────────────────────────
// Lightweight counter table: one row per user per action per day.
// Checked before expensive operations (resume upload, job post, application).

export const dailyUsageLimits = pgTable("daily_usage_limits", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  action: varchar("action", { length: 50 }).notNull(),   // e.g. "resume_upload", "job_post", "application"
  count: integer("count").default(0).notNull(),
  date: varchar("date", { length: 10 }).notNull(),        // YYYY-MM-DD (UTC)
}, (table: any) => ({
  uniqUserActionDate: unique("uniq_daily_usage").on(table.userId, table.action, table.date),
}));

export type DailyUsageLimit = typeof dailyUsageLimits.$inferSelect;

// ── Observability: error events ───────────────────────────────────────────────
// In-house error tracking. Replaces external Sentry for early access.
// Capped via daily cleanup cron (keep last 30 days).

export const errorEvents = pgTable("error_events", {
  id: serial("id").primaryKey(),
  level: varchar("level", { length: 10 }).notNull().default("error"),  // error, warning, fatal
  message: text("message").notNull(),
  stack: text("stack"),
  endpoint: varchar("endpoint", { length: 200 }),
  method: varchar("method", { length: 10 }),
  statusCode: integer("status_code"),
  userId: varchar("user_id", { length: 100 }),
  component: varchar("component", { length: 100 }),  // e.g. "express", "exam-service", "resume-parser"
  metadata: jsonb("metadata"),
  fingerprint: varchar("fingerprint", { length: 64 }),  // sha256 of message+component for grouping
  createdAt: timestamp("created_at").defaultNow(),
}, (table: any) => ({
  idxErrorCreatedAt: index("idx_error_created_at").on(table.createdAt),
  idxErrorFingerprint: index("idx_error_fingerprint").on(table.fingerprint),
  idxErrorLevel: index("idx_error_level").on(table.level),
}));

export type ErrorEvent = typeof errorEvents.$inferSelect;

// ── Observability: request latency metrics ────────────────────────────────────
// Sampled at 20% in production to keep table size manageable.
// Used by /admin/metrics for p50/p95/p99 per endpoint.
export const requestMetrics = pgTable("request_metrics", {
  id: serial("id").primaryKey(),
  endpoint: varchar("endpoint", { length: 200 }).notNull(),
  method: varchar("method", { length: 10 }).notNull(),
  statusCode: integer("status_code").notNull(),
  durationMs: integer("duration_ms").notNull(),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table: any) => ({
  idxMetricsEndpoint: index("idx_metrics_endpoint").on(table.endpoint, table.createdAt),
  idxMetricsCreatedAt: index("idx_metrics_created_at").on(table.createdAt),
}));

// ── Observability: scheduled-pipeline (cron) heartbeats ───────────────────────
// One row per cron/script run (GitHub Actions). Lets the admin page show whether
// each ingestion/embedding pipeline last ran, when, and with what result —
// instead of relying on GitHub's failure email that nobody watches. Capped via
// the weekly cleanup cron (keep last 30 days).
export const pipelineRuns = pgTable("pipeline_runs", {
  id: serial("id").primaryKey(),
  pipeline: varchar("pipeline", { length: 80 }).notNull(),  // e.g. "batch-embeddings", "scrape-ats"
  status: varchar("status", { length: 16 }).notNull(),       // "ok" | "warning" | "failed"
  startedAt: timestamp("started_at").notNull(),
  finishedAt: timestamp("finished_at").defaultNow(),
  durationMs: integer("duration_ms"),
  itemsProcessed: integer("items_processed").default(0),
  itemsFailed: integer("items_failed").default(0),
  message: text("message"),                                  // human summary, e.g. "800 written, 4200 throttled"
  stats: jsonb("stats"),                                     // arbitrary per-pipeline detail
  createdAt: timestamp("created_at").defaultNow(),
}, (table: any) => ({
  idxPipelineRunsLatest: index("idx_pipeline_runs_latest").on(table.pipeline, table.createdAt),
  idxPipelineRunsCreatedAt: index("idx_pipeline_runs_created_at").on(table.createdAt),
}));

export type PipelineRun = typeof pipelineRuns.$inferSelect;

export const discoveredCompanies = pgTable("discovered_companies", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  normalizedName: varchar("normalizedName", { length: 255 }).notNull().unique(),
  careerPageUrl: varchar("careerPageUrl", { length: 500 }),
  discoverySource: varchar("discoverySource", { length: 100 }).notNull(),
  detectedAts: varchar("detectedAts", { length: 50 }),
  atsId: varchar("atsId", { length: 255 }),
  jobCount: integer("jobCount").default(0),
  status: varchar("status", { length: 50 }).default("pending"),
  createdAt: timestamp("createdAt").defaultNow(),
  updatedAt: timestamp("updatedAt").defaultNow(),
  /** When the ATS probe last attempted this company. NULL = never probed. */
  lastProbedAt: timestamp("lastProbedAt"),
}, (table: any) => {
  return {
    idx_discovered_status: index("idx_discovered_status").on(table.status),
    idx_discovered_ats: index("idx_discovered_ats").on(table.detectedAts),
  }
});

/**
 * Match signals — training data for the feedback loop.
 *
 * Every candidate×job interaction is recorded with the full feature snapshot
 * that produced the match score. When an exam score arrives, it's joined back
 * to the signal, creating a labeled data point for weight tuning.
 */
export const matchSignals = pgTable("match_signals", {
  id: serial("id").primaryKey(),
  candidateId: varchar("candidate_id", { length: 255 }).notNull(),
  jobId: integer("job_id").notNull(),
  action: varchar("action", { length: 30 }).notNull(), // apply, hide, save, skip, exam

  // Feature snapshot at the time of interaction
  keywordScore: integer("keyword_score"),       // 0-100
  semanticScore: integer("semantic_score"),      // 0-100
  titleScore: integer("title_score"),            // 0-100
  experienceScore: integer("experience_score"),  // 0-100
  contextBonus: integer("context_bonus"),        // 0-8
  matchScore: integer("match_score"),            // 0-100 (final blended score)
  hasSemanticSignal: boolean("has_semantic_signal").default(false),

  // Outcome — filled when exam score arrives
  examScore: integer("exam_score"),              // 0-100, nullable until exam taken
  examJoinedAt: timestamp("exam_joined_at"),     // when the exam score was linked

  createdAt: timestamp("created_at").defaultNow(),
}, (table: any) => ({
  idx_signals_candidate: index("idx_signals_candidate").on(table.candidateId),
  idx_signals_job: index("idx_signals_job").on(table.jobId),
  idx_signals_action: index("idx_signals_action").on(table.action),
  idx_signals_exam: index("idx_signals_exam_score").on(table.examScore),
}));

/**
 * Learned scoring weights — persisted output of the weight tuner.
 * scoreJob() reads the latest row on startup; admin cron writes new rows.
 */
export const scoringWeights = pgTable("scoring_weights", {
  id: serial("id").primaryKey(),
  keywordWeight: numeric("keyword_weight").notNull(),
  semanticWeight: numeric("semantic_weight").notNull(),
  titleWeight: numeric("title_weight").notNull(),
  experienceWeight: numeric("experience_weight").notNull(),
  // Metadata
  trainingSamples: integer("training_samples").notNull(),
  meanAbsoluteError: numeric("mean_absolute_error"),  // MAE vs exam scores
  correlation: numeric("correlation"),                  // Pearson r vs exam scores
  createdAt: timestamp("created_at").defaultNow(),
});
