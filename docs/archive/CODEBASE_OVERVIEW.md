# Recrutas Codebase Overview

## Executive Summary

Recrutas is an AI-powered hiring platform that connects job seekers with employers through intelligent matching, automated resume parsing, and real-time communication. The platform serves two primary user types: **Candidates** (job seekers) and **Talent Owners** (recruiters/employers).

---

## Architecture Overview

### Technology Stack

**Frontend:**
- React 18 with TypeScript
- Vite for build tooling
- Tailwind CSS + shadcn/ui for styling
- TanStack Query for state management
- Wouter for routing
- WebSocket for real-time notifications

**Backend:**
- Node.js with Express.js
- TypeScript
- Drizzle ORM for database operations
- Supabase (PostgreSQL) for database and authentication
- WebSocket server for real-time features

**AI Services:**
- Groq API (Llama 3) for resume parsing
- Custom semantic matching engine for job matching
- OpenAI-compatible embeddings for skill matching

**External Integrations:**
- Multiple job aggregation APIs (JSearch, ArbeitNow, RemoteOK, The Muse, etc.)
- Company career page scrapers (Google, Apple, Amazon, Meta, Microsoft, etc.)
- Supabase Storage for resume files

---

## Core Data Models

### User & Profile Entities

1. **Users** - Base user table with authentication info
   - `id`, `email`, `name`, `role` (candidate/talent_owner)
   - `profile_complete` flag

2. **CandidateProfiles** - Extended candidate information
   - Skills, experience, location, salary expectations
   - Resume URL, portfolio links (LinkedIn, GitHub, etc.)
   - Profile strength score, view count

3. **JobPostings** - Job listings
   - Title, company, description, requirements
   - Skills, location, salary range, work type
   - Status (active/paused/closed)
   - Exam configuration (hasExam, passingScore)
   - Auto-ranking and chat access settings

### Matching & Application Entities

4. **JobMatches** - AI-generated job matches for candidates
   - Match score, confidence level
   - AI explanation, skill matches
   - Status (pending/viewed/interested/applied/rejected)

5. **JobApplications** - Candidate applications
   - Status workflow: submitted → viewed → screening → interview → offer/rejected
   - Auto-filled flag, resume URL, cover letter
   - Interview link, notes

6. **ApplicationEvents** - Detailed event tracking
   - Event types: viewed, screened, shortlisted, rejected, interviewed, hired
   - Actor information (recruiter, hiring manager)
   - View duration, candidate ranking, feedback

7. **ApplicationInsights** - AI-generated insights for candidates
   - Strengths identified, improvement areas
   - Benchmark comparisons, success probability
   - Recommended actions, supportive messages

### Assessment & Communication

8. **JobExams** - Screening exams for jobs
   - Questions (multiple-choice, short-answer)
   - Time limit, passing score

9. **ExamAttempts** - Candidate exam submissions
   - Score, answers, time spent
   - Passed exam flag, qualified for chat
   - Ranking among candidates

10. **ChatRooms** - Direct messaging between candidates and recruiters
    - Created after exam qualification
    - Candidate ranking, access granted timestamp

11. **ChatMessages** - Individual messages in chat rooms

### Notification System

12. **Notifications** - User notifications
    - Types: application_viewed, application_ranked, new_match, exam_completed, etc.
    - Priority levels, read status
    - Related entities (job, application, match)

13. **NotificationPreferences** - User notification settings
    - In-app, email, push preferences
    - Quiet hours, type-specific preferences

---

## End-to-End Workflows

### Workflow 1: Candidate Journey (Signup to Application)

#### Step 1: Registration & Profile Setup
1. **Signup** (`/signup/candidate`)
   - User creates account via Supabase Auth
   - Role set to "candidate"
   - User record created in `users` table

2. **Guided Setup** (`/role-selection` → `/guided-setup`)
   - Multi-step wizard:
     - Basic info (name, email, phone)
     - Skills selection
     - Resume upload (PDF/DOCX)
     - Location and work preferences
   - Resume uploaded to Supabase Storage
   - Resume parsed using AI (Groq/Llama 3)
   - Candidate profile created/updated in `candidateProfiles`

3. **Resume Processing** (`POST /api/candidate/resume`)
   - File uploaded via multer
   - `ResumeService.uploadAndProcessResume()`:
     - Extracts text (PDF via pdf-parse, DOCX via mammoth)
     - AI parsing extracts: skills, experience, education, projects
     - Stores resume text and extracted data
     - Updates candidate profile with parsed information

#### Step 2: Job Discovery & Matching
1. **AI Job Matching** (`GET /api/ai-matches`)
   - Fetches candidate profile
   - Aggregates jobs from:
     - External sources (company aggregator, job aggregator)
     - Internal job postings
   - Filters out hidden jobs
   - For each job (top 15):
     - Calls `generateJobMatch()` from `ai-service.ts`
     - Uses semantic skill matching (cosine similarity on embeddings)
     - Calculates experience, location, salary fit
     - Generates AI explanation
   - Returns top 10 matches sorted by score

2. **Match Display** (`/candidate-dashboard`)
   - Shows AI-matched jobs with:
     - Match score percentage
     - Confidence level
     - AI explanation
     - Skill matches highlighted
   - Candidate can:
     - View match details
     - Save job
     - Hide job
     - Apply directly

#### Step 3: Job Application
1. **Apply to Job** (`POST /api/candidates/apply/:jobId`)
   - Creates `jobApplication` record
   - Status: "submitted"
   - Creates activity log
   - Sends notification to talent owner
   - If job has exam:
     - Candidate redirected to exam page
   - If no exam:
     - Application moves to "viewed" status when recruiter opens it

2. **Screening Exam** (if enabled) (`/exam/:id`)
   - Candidate takes exam:
     - Multiple-choice and short-answer questions
     - Time limit enforced
     - Answers stored in `examAttempts`
   - Exam scored automatically
   - If score >= passing score:
     - `passedExam = true`
     - `qualifiedForChat = true`
     - Candidate ranked among other applicants
     - Chat room created automatically
     - Notification sent to talent owner

#### Step 4: Application Tracking
1. **Application Status Updates**
   - Recruiter updates status via `PUT /api/applications/:applicationId/status`
   - Status transitions:
     - submitted → viewed → screening → interview_scheduled → interview_completed → offer/rejected
   - Each status change:
     - Creates `applicationUpdate` record
     - Creates `applicationEvent` record
     - Sends notification to candidate
     - Updates `applicationInsights` if applicable

2. **Application Intelligence** (`GET /api/candidate/applications`)
   - Shows all applications with status
   - Displays insights:
     - Strengths identified
     - Improvement areas
     - Benchmark comparisons
     - Success probability
     - Recommended actions

#### Step 5: Direct Communication
1. **Chat Access** (`/chat/:id`)
   - Available after exam qualification (top N candidates)
   - Real-time messaging via WebSocket
   - Messages stored in `chatMessages`
   - Both parties notified of new messages

---

### Workflow 2: Recruiter/Talent Owner Journey

#### Step 1: Registration & Setup
1. **Signup** (`/signup/talent-owner`)
   - User creates account
   - Role set to "talent_owner"
   - Guided setup for company profile

2. **Company Profile**
   - Company information
   - Hiring preferences
   - Notification settings

#### Step 2: Job Posting Creation
1. **Create Job** (`POST /api/jobs`)
   - Job details:
     - Title, company, description
     - Requirements, skills
     - Location, salary range, work type
     - Industry
   - Exam configuration:
     - `hasExam` flag
     - `examPassingScore` (default 70)
     - `autoRankCandidates` flag
     - `maxChatCandidates` (default 5)
   - Job created in `jobPostings`
   - If `hasExam = true`:
     - Exam created with auto-generated questions
     - Questions based on job skills and requirements

2. **Auto-Matching** (happens on job creation)
   - System finds matching candidates:
     - Fetches all candidate profiles
     - Calculates skill overlap
     - Creates `jobMatch` records for candidates with score > 0
   - Notifications sent to matched candidates
   - Candidates see new match in their feed

#### Step 3: Applicant Management
1. **View Applicants** (`GET /api/jobs/:jobId/applicants`)
   - Lists all applicants for the job
   - Shows:
     - Application status
     - Exam scores (if applicable)
     - Candidate ranking
     - Profile information

2. **Application Review**
   - Recruiter views application
   - Creates `applicationEvent` (type: "viewed")
   - Updates application status
   - Candidate notified of view

3. **Exam Review** (if exam enabled)
   - View exam attempts
   - See scores and answers
   - System auto-ranks candidates by score
   - Top N candidates get chat access

#### Step 4: Candidate Evaluation
1. **Status Updates**
   - Recruiter updates application status
   - Each update:
     - Creates event record
     - Sends notification
     - Updates insights for candidate

2. **Interview Scheduling**
   - Recruiter schedules interview
   - Creates `interview` record
   - Sends notification with meeting link
   - Status updated to "interview_scheduled"

3. **Decision Making**
   - Final status: "offer" or "rejected"
   - Candidate notified
   - Application archived

#### Step 5: Analytics & Insights
1. **Recruiter Stats** (`GET /api/recruiter/stats`)
   - Active jobs count
   - Total matches
   - Active chats
   - Hires count

2. **Application Intelligence**
   - View candidate insights
   - Benchmark comparisons
   - Success probability estimates

---

## Key Services & Components

### Backend Services

1. **AI Service** (`server/ai-service.ts`)
   - `generateJobMatch()` - Semantic matching using skill embeddings
   - `generateScreeningQuestions()` - AI-generated exam questions
   - Uses cosine similarity for skill matching
   - Context-aware scoring (location, salary, work type)

2. **Resume Service** (`server/services/resume.service.ts`)
   - Handles resume upload and processing
   - Integrates with AI resume parser
   - Stores files in Supabase Storage
   - Updates candidate profile

3. **AI Resume Parser** (`server/ai-resume-parser.ts`)
   - Extracts text from PDF/DOCX
   - Uses Groq API for AI extraction
   - Extracts: skills, experience, education, projects, certifications
   - Calculates confidence score

4. **Job Aggregator** (`server/job-aggregator.ts`)
   - Fetches jobs from multiple sources:
     - JSearch API (RapidAPI)
     - ArbeitNow (European jobs)
     - RemoteOK
     - The Muse
     - Indeed RSS
     - USAJobs.gov
   - Transforms and normalizes job data
   - Removes duplicates

5. **Company Jobs Aggregator** (`server/company-jobs-aggregator.ts`)
   - Fetches from company career pages:
     - Google, Apple, Amazon, Meta, Microsoft, Tesla, Netflix, etc.
   - Caches results (45 seconds)
   - Filters recent jobs only

6. **Advanced Matching Engine** (`server/advanced-matching-engine.ts`)
   - Enhanced matching with urgency scoring
   - Compatibility factor analysis
   - Caches match results

7. **Notification Service** (`server/notification-service.ts`)
   - WebSocket connection management
   - Real-time notification delivery
   - Email notification support (stubbed)
   - Notification preferences handling
   - Quiet hours support

8. **Storage Layer** (`server/storage.ts`)
   - Repository pattern implementation
   - All database operations
   - Type-safe with Drizzle ORM
   - Comprehensive CRUD operations

### Frontend Components

1. **Candidate Dashboard** (`pages/candidate-dashboard-streamlined.tsx`)
   - AI job matches feed
   - Application tracker
   - Profile completion
   - Saved jobs
   - Notifications

2. **Talent Dashboard** (`pages/talent-dashboard.tsx`)
   - Job postings management
   - Applicant tracking
   - Analytics
   - Chat interface

3. **Job Matching Components**
   - `ai-job-feed.tsx` - Displays AI-matched jobs
   - `match-card.tsx` - Individual match card
   - `match-breakdown.tsx` - Detailed match analysis

4. **Application Intelligence** (`components/application-intelligence-tracker.tsx`)
   - Real-time application status
   - Insights and recommendations
   - Benchmark comparisons

5. **Chat Interface** (`components/real-time-chat.tsx`)
   - WebSocket-based messaging
   - Real-time message delivery
   - File sharing support

6. **Notification Center** (`components/notification-center.tsx`)
   - Real-time notifications
   - Mark as read functionality
   - Priority-based filtering

---

## API Endpoints Summary

### Authentication
- `GET /api/auth/user` - Get current user
- `POST /api/auth/role` - Set user role

### Candidate Endpoints
- `GET /api/candidate/profile` - Get candidate profile
- `POST /api/candidate/profile` - Update candidate profile
- `POST /api/candidate/resume` - Upload and parse resume
- `GET /api/candidate/stats` - Get candidate statistics
- `GET /api/candidate/applications` - Get all applications
- `GET /api/candidate/activity` - Get activity logs
- `POST /api/candidate/saved-jobs` - Save a job
- `DELETE /api/candidate/saved-jobs/:jobId` - Unsave a job
- `POST /api/candidate/hidden-jobs` - Hide a job
- `GET /api/candidate/job-actions` - Get saved/applied jobs

### Job Matching
- `GET /api/ai-matches` - Get AI-powered job matches
- `POST /api/candidates/apply/:jobId` - Apply to a job

### Talent Owner Endpoints
- `GET /api/talent-owner/jobs` - Get all job postings
- `POST /api/jobs` - Create job posting
- `GET /api/jobs/:jobId/applicants` - Get applicants for a job
- `PUT /api/applications/:applicationId/status` - Update application status
- `GET /api/recruiter/stats` - Get recruiter statistics

### External Jobs
- `GET /api/external-jobs` - Get aggregated external jobs

### Platform
- `GET /api/platform/stats` - Get platform statistics
- `GET /api/news/layoffs` - Get layoff news

### Development
- `POST /api/dev/seed` - Seed database with sample data

---

## Real-Time Features

### WebSocket Server
- Endpoint: `/ws?userId=<userId>`
- Handles:
  - Notification delivery
  - Chat messages
  - Connection status tracking
- Heartbeat mechanism (30s intervals)

### Notification Types
1. **Application Events**
   - `application_viewed` - Recruiter viewed application
   - `application_ranked` - Candidate ranked
   - `application_accepted` - Application accepted
   - `application_rejected` - Application rejected
   - `status_update` - Status changed

2. **Match Events**
   - `new_match` - New job match found
   - `direct_connection` - Direct connection request

3. **Exam Events**
   - `exam_completed` - Exam submitted
   - `high_score_alert` - High exam score

4. **Communication**
   - `candidate_message` - New chat message
   - `interview_scheduled` - Interview scheduled

---

## AI & Matching Algorithms

### Job Matching Algorithm

1. **Skill Matching** (Semantic)
   - Pre-computed skill embeddings
   - Cosine similarity calculation
   - Handles partial matches and synonyms
   - Score: 0-1 (40% weight)

2. **Experience Matching**
   - Semantic analysis of experience text
   - Seniority keyword matching
   - Technical keyword overlap
   - Score: 0-1 (30% weight)

3. **Contextual Fit**
   - Location compatibility
   - Work type alignment
   - Salary expectations
   - Industry relevance
   - Score: 0-1 (30% weight)

4. **Final Score**
   - Weighted combination of all factors
   - Confidence level calculation
   - AI explanation generation

### Resume Parsing

1. **Text Extraction**
   - PDF: pdf-parse library
   - DOCX: mammoth library

2. **AI Extraction** (Groq/Llama 3)
   - Personal information
   - Skills (technical, soft, tools)
   - Experience (positions, responsibilities)
   - Education
   - Certifications
   - Projects
   - Languages

3. **Confidence Calculation**
   - Based on extracted data completeness
   - Field validation

---

## Data Flow Diagrams

### Candidate Application Flow

```
User Signup
  ↓
Profile Setup (Guided Wizard)
  ↓
Resume Upload → AI Parsing → Profile Update
  ↓
AI Job Matching (Background Process)
  ↓
Match Display in Dashboard
  ↓
Candidate Applies to Job
  ↓
[If Exam Enabled] → Take Exam → Score → Rank
  ↓
[If Qualified] → Chat Access Granted
  ↓
Application Status Updates (via Recruiter)
  ↓
Notifications → Candidate
  ↓
Final Decision (Offer/Rejected)
```

### Recruiter Workflow

```
Recruiter Signup
  ↓
Create Job Posting
  ↓
Auto-Match Candidates (Background)
  ↓
Candidates Apply
  ↓
[If Exam Enabled] → Review Exam Scores → Rank Candidates
  ↓
Review Applications
  ↓
Update Status → Notify Candidate
  ↓
[If Qualified] → Chat with Candidate
  ↓
Schedule Interview
  ↓
Make Decision (Offer/Reject)
```

---

## Key Features

### For Candidates

1. **AI-Powered Job Feed**
   - Intelligent matching based on profile
   - External + internal job aggregation
   - Real-time match updates

2. **Resume Parsing**
   - Automatic profile building from resume
   - AI extraction of skills and experience
   - One-click profile completion

3. **Application Tracking**
   - Real-time status updates
   - Application insights and recommendations
   - Benchmark comparisons

4. **Direct Communication**
   - Chat with recruiters (after qualification)
   - Real-time messaging
   - Notification system

5. **Screening Exams**
   - Automated skill assessment
   - Performance-based ranking
   - Chat access qualification

### For Recruiters

1. **Job Posting Management**
   - Rich job descriptions
   - Exam creation
   - Auto-matching candidates

2. **Applicant Tracking**
   - Application status workflow
   - Exam score review
   - Candidate ranking

3. **Communication**
   - Direct chat with qualified candidates
   - Interview scheduling
   - Status updates

4. **Analytics**
   - Recruiter statistics
   - Application insights
   - Performance metrics

---

## Security & Authentication

- **Supabase Auth** for user authentication
- **JWT tokens** for API authentication
- **Role-based access control** (candidate vs talent_owner)
- **Middleware** (`isAuthenticated`) for protected routes
- **File upload validation** (PDF, DOCX only, 5MB limit)
- **Input validation** with Zod schemas

---

## Caching Strategy

1. **Job Aggregation Cache**
   - 45 seconds for company jobs
   - Reduces API calls

2. **Match Cache**
   - 1 minute for advanced matches
   - Per-candidate cache key

3. **Database Query Optimization**
   - Indexed columns
   - Efficient joins
   - Pagination support

---

## External Dependencies

### APIs
- **Groq API** - Resume parsing (Llama 3)
- **RapidAPI** - JSearch job data
- **Supabase** - Database, auth, storage

### Job Sources
- JSearch, ArbeitNow, RemoteOK, The Muse
- Company career pages (Google, Apple, Amazon, etc.)
- Indeed RSS, USAJobs.gov

---

## Development Workflow

### Local Development
1. `npm install` - Install dependencies
2. Set up `.env` with Supabase credentials and API keys
3. `npm run db:push` - Push database schema
4. `npm run dev:all` - Start frontend and backend
5. `curl -X POST http://localhost:5000/api/dev/seed` - Seed database

### Testing
- `npm test` - Run tests
- `npm run test:backend` - Backend tests
- `npm run test:frontend` - Frontend tests
- `npm run test:e2e` - E2E tests (Playwright)

---

## Future Enhancements (Based on Code Structure)

1. **Email Notifications** - Currently stubbed, needs SendGrid integration
2. **Video Interviews** - Component exists but needs integration
3. **Advanced Analytics** - Dashboard components exist
4. **HR Integrations** - Module exists but not fully implemented
5. **Market Intelligence** - Service exists but needs expansion

---

## File Structure Summary

```
recrutas/
├── client/              # React frontend
│   ├── src/
│   │   ├── components/  # UI components
│   │   ├── pages/       # Page components
│   │   ├── hooks/       # Custom React hooks
│   │   ├── lib/         # Utilities and configs
│   │   └── utils/       # Helper functions
│
├── server/              # Express backend
│   ├── routes.ts        # API route definitions
│   ├── storage.ts       # Data access layer
│   ├── ai-service.ts    # AI matching logic
│   ├── job-aggregator.ts # External job fetching
│   ├── notification-service.ts # Real-time notifications
│   └── services/        # Business logic services
│
├── shared/              # Shared code
│   └── schema.ts        # Database schema (Drizzle)
│
└── docs/                # Documentation
```

---

This overview provides a comprehensive understanding of the Recrutas platform, its architecture, workflows, and key features. The system is designed to streamline the hiring process through AI-powered matching, automated assessments, and real-time communication.
