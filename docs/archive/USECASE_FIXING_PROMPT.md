# End-to-End Use Case Testing & Fixing Prompt

Use this prompt to systematically test and fix all user journeys and use cases in the Recrutas platform.

## Context
Recrutas is an AI-powered hiring platform with two user types: **Candidates** and **Talent Owners (Recruiters)**. The platform uses:
- Frontend: React + TypeScript + Vite
- Backend: Express.js + TypeScript
- Database: Supabase (PostgreSQL) with Drizzle ORM
- AI: Groq API for resume parsing, custom semantic matching
- Real-time: WebSocket for notifications and chat
- External APIs: Job aggregators, company career pages, news APIs

---

## Use Case Checklist: Test & Fix Each Flow

### 🔵 CANDIDATE USER JOURNEY

#### 1. Candidate Registration & Onboarding
**Flow:** Signup → Role Selection → Profile Setup → Resume Upload

**Test Steps:**
- [ ] User can sign up at `/signup/candidate`
- [ ] User can select "candidate" role
- [ ] User is redirected to guided setup (`/role-selection` or `/guided-setup`)
- [ ] Guided setup wizard works:
  - [ ] Basic info step (name, email, phone)
  - [ ] Skills selection step
  - [ ] Resume upload step
  - [ ] Location and work preferences step
- [ ] Profile completion status updates correctly
- [ ] User redirected to candidate dashboard after completion

**API Endpoints to Verify:**
- `POST /api/auth/role` - Sets user role
- `POST /api/candidate/profile` - Updates profile
- `POST /api/candidate/resume` - Uploads resume

**Common Issues to Check:**
- Authentication state not persisting
- Profile data not saving
- Redirect loops
- Form validation errors

---

#### 2. Resume Upload & AI Parsing
**Flow:** Upload Resume → Extract Text → AI Parse → Update Profile

**Test Steps:**
- [ ] User can upload PDF resume (max 5MB)
- [ ] User can upload DOCX resume (max 5MB)
- [ ] File validation works (rejects invalid types)
- [ ] Resume text extraction works:
  - [ ] PDF text extraction via `pdf-parse`
  - [ ] DOCX text extraction via `mammoth`
- [ ] AI resume parsing triggers:
  - [ ] Groq API call succeeds
  - [ ] Skills extracted correctly
  - [ ] Experience extracted correctly
  - [ ] Education extracted correctly
  - [ ] Projects extracted correctly
- [ ] Parsed data updates candidate profile:
  - [ ] Skills array populated
  - [ ] Experience text saved
  - [ ] Resume text stored
  - [ ] Resume URL saved to Supabase Storage
- [ ] Profile strength score updates
- [ ] Loading states show during processing
- [ ] Error handling for failed uploads/parsing

**API Endpoints to Verify:**
- `POST /api/candidate/resume` - Handles file upload
- `ResumeService.uploadAndProcessResume()` - Processes file
- `aiResumeParser.parseFile()` - Parses resume
- Supabase Storage bucket "resumes" exists and is accessible

**Common Issues to Check:**
- File upload fails (multer config, file size limits)
- Text extraction fails (PDF/DOCX parsing errors)
- Groq API errors (API key, rate limits, network)
- Supabase Storage errors (bucket permissions, upload failures)
- Profile not updating after parsing
- Missing error messages to user

---

#### 3. AI Job Matching & Job Feed
**Flow:** Load Dashboard → Fetch Matches → Display Jobs (Internal + External)

**Test Steps:**
- [ ] Candidate dashboard loads (`/candidate-dashboard`)
- [ ] AI matches endpoint called: `GET /api/ai-matches`
- [ ] Job aggregation works:
  - [ ] Internal jobs fetched from database (`jobPostings` table)
  - [ ] External jobs fetched from `companyJobsAggregator.getAllCompanyJobs()`
  - [ ] External jobs fetched from `jobAggregator.getAllJobs()`
- [ ] Hidden jobs filtered out
- [ ] AI matching runs for each job:
  - [ ] `generateJobMatch()` called with candidate profile and job
  - [ ] Semantic skill matching works
  - [ ] Match score calculated (0-100%)
  - [ ] Confidence level assigned
  - [ ] AI explanation generated
- [ ] Only matches with score >= 60% shown
- [ ] Jobs sorted by match score (highest first)
- [ ] Top 10 matches displayed
- [ ] Job cards show:
  - [ ] Job title, company, location
  - [ ] Match score percentage
  - [ ] Confidence level badge
  - [ ] AI explanation
  - [ ] Skills matched
  - [ ] Work type, salary range
- [ ] External jobs marked as "AI Curated"
- [ ] Internal jobs marked as "Platform Job"
- [ ] Loading states during fetch
- [ ] Error handling for failed matches

**API Endpoints to Verify:**
- `GET /api/ai-matches` - Returns AI-matched jobs
- `GET /api/external-jobs` - Returns external jobs (if used separately)
- `companyJobsAggregator.getAllCompanyJobs()` - Fetches company jobs
- `jobAggregator.getAllJobs()` - Fetches aggregated jobs
- `generateJobMatch()` - Calculates match scores

**Components to Verify:**
- `AIJobFeed` component renders correctly
- `MatchCard` component shows match details
- `MatchBreakdown` component displays analysis

**Common Issues to Check:**
- No jobs showing (aggregation failing)
- External jobs not loading (API keys, rate limits, network)
- AI matching not running (service errors)
- Match scores always 0 or incorrect
- Jobs not sorted correctly
- Hidden jobs still showing
- Performance issues (too many API calls)
- Caching not working

---

#### 4. Job Actions (Save, Hide, Apply)
**Flow:** View Job → Save/Hide/Apply → Update State

**Test Steps:**
- [ ] User can save a job:
  - [ ] `POST /api/candidate/saved-jobs` called
  - [ ] Job added to `savedJobs` table
  - [ ] UI updates (save button state)
- [ ] User can unsave a job:
  - [ ] `DELETE /api/candidate/saved-jobs/:jobId` called
  - [ ] Job removed from `savedJobs` table
- [ ] User can hide a job:
  - [ ] `POST /api/candidate/hidden-jobs` called
  - [ ] Job added to `hiddenJobs` table
  - [ ] Job disappears from feed
- [ ] User can apply to a job:
  - [ ] `POST /api/candidates/apply/:jobId` called
  - [ ] Application created in `jobApplications` table
  - [ ] Status set to "submitted"
  - [ ] Activity log created
  - [ ] Notification sent to talent owner
  - [ ] If job has exam: redirect to exam page
  - [ ] If no exam: application status updates
- [ ] Saved/applied state persists across page reloads
- [ ] `GET /api/candidate/job-actions` returns correct saved/applied lists

**API Endpoints to Verify:**
- `POST /api/candidate/saved-jobs`
- `DELETE /api/candidate/saved-jobs/:jobId`
- `POST /api/candidate/hidden-jobs`
- `POST /api/candidates/apply/:jobId`
- `GET /api/candidate/job-actions`

**Common Issues to Check:**
- Save/hide actions not persisting
- Duplicate applications allowed
- Notifications not sent
- State not updating in UI
- Database constraints violations

---

#### 5. Screening Exam (If Enabled)
**Flow:** Apply to Job → Take Exam → Submit → Score → Rank

**Test Steps:**
- [ ] Exam page loads (`/exam/:id`)
- [ ] Exam questions fetched from `jobExams` table
- [ ] Questions display correctly:
  - [ ] Multiple-choice questions
  - [ ] Short-answer questions
- [ ] Timer works (if time limit set)
- [ ] User can answer questions
- [ ] Answers saved to state
- [ ] Submit exam:
  - [ ] `POST /api/exams/:id/submit` (or equivalent) called
  - [ ] Exam attempt created in `examAttempts` table
  - [ ] Answers stored
  - [ ] Score calculated
  - [ ] Time spent recorded
  - [ ] Status set to "completed"
- [ ] If score >= passing score:
  - [ ] `passedExam = true`
  - [ ] `qualifiedForChat = true`
  - [ ] Candidate ranked
  - [ ] Chat room created
  - [ ] Notification sent to talent owner
- [ ] Results displayed to candidate
- [ ] Redirect to appropriate page

**API Endpoints to Verify:**
- `GET /api/jobs/:jobId/exam` - Gets exam questions
- `POST /api/exams/:id/submit` - Submits exam
- `storage.createExamAttempt()` - Creates attempt
- `storage.rankCandidatesByExamScore()` - Ranks candidates

**Common Issues to Check:**
- Exam not loading
- Questions not displaying
- Timer not working
- Answers not saving
- Score calculation incorrect
- Ranking not happening
- Chat room not created
- Notifications not sent

---

#### 6. Application Tracking
**Flow:** View Applications → Status Updates → Insights

**Test Steps:**
- [ ] Applications list loads:
  - [ ] `GET /api/candidate/applications` called
  - [ ] All applications for candidate returned
  - [ ] Status displayed correctly
- [ ] Application status updates in real-time:
  - [ ] WebSocket notifications received
  - [ ] Status changes reflected in UI
  - [ ] Activity log updated
- [ ] Application insights display:
  - [ ] `GET /api/applications/:id/insights` (if exists)
  - [ ] Strengths identified
  - [ ] Improvement areas
  - [ ] Benchmark comparisons
  - [ ] Success probability
- [ ] Application events timeline shows:
  - [ ] Viewed events
  - [ ] Status changes
  - [ ] Interview scheduled
  - [ ] Decision made

**API Endpoints to Verify:**
- `GET /api/candidate/applications`
- `GET /api/applications/:id/insights` (if exists)
- `GET /api/applications/:id/events` (if exists)
- WebSocket notifications

**Common Issues to Check:**
- Applications not loading
- Status not updating
- Insights not generating
- WebSocket not connecting
- Real-time updates not working

---

#### 7. Layoff News Tab
**Flow:** Navigate to News Tab → Fetch News → Display Articles

**Test Steps:**
- [ ] Layoff news tab accessible in dashboard
- [ ] `GET /api/news/layoffs` called
- [ ] News service fetches from News API:
  - [ ] `newsService.getLayoffNews()` executes
  - [ ] NEWS_API_KEY configured
  - [ ] API call succeeds
  - [ ] Articles returned
- [ ] News cached (45 seconds or configured duration)
- [ ] Articles display:
  - [ ] Title
  - [ ] Description
  - [ ] Source
  - [ ] Published date
  - [ ] Link to article
- [ ] Error handling:
  - [ ] Shows message if API key missing
  - [ ] Shows message if API fails
  - [ ] Shows cached data if available
- [ ] Loading states during fetch

**API Endpoints to Verify:**
- `GET /api/news/layoffs`
- `newsService.getLayoffNews()`

**Components to Verify:**
- `LayoffNews` component renders
- News articles display correctly

**Common Issues to Check:**
- NEWS_API_KEY not set
- API rate limits exceeded
- News not loading
- Caching not working
- Error messages not shown
- Component not rendering

---

### 🟢 TALENT OWNER USER JOURNEY

#### 8. Talent Owner Registration & Company Setup
**Flow:** Signup → Role Selection → Company Profile Setup

**Test Steps:**
- [ ] User can sign up at `/signup/talent-owner`
- [ ] User can select "talent_owner" role
- [ ] User redirected to company profile setup
- [ ] Company profile form works:
  - [ ] Company name
  - [ ] Company description
  - [ ] Company website
  - [ ] Company logo upload (if available)
  - [ ] Industry
  - [ ] Location
- [ ] Profile saves:
  - [ ] `POST /api/talent-owner/profile` (or equivalent) called
  - [ ] Company data stored (may be in `users` table or separate)
  - [ ] Profile completion status updates
- [ ] User redirected to talent dashboard

**API Endpoints to Verify:**
- `POST /api/auth/role` - Sets role to talent_owner
- `POST /api/talent-owner/profile` (if exists)
- Or company data stored in user profile

**Components to Verify:**
- `TalentOwnerProfileCompletion` component
- Company profile form

**Common Issues to Check:**
- Company data not saving
- Profile not completing
- Redirect not working
- Form validation errors

---

#### 9. Job Posting Creation
**Flow:** Create Job → Fill Details → Configure Exam → Publish → Auto-Match

**Test Steps:**
- [ ] Job posting wizard opens:
  - [ ] `JobPostingWizard` component renders
  - [ ] Multi-step form works
- [ ] Job details form:
  - [ ] Title required
  - [ ] Company auto-filled or editable
  - [ ] Description textarea
  - [ ] Requirements (array input)
  - [ ] Skills (array input, tags)
  - [ ] Location
  - [ ] Salary range (min/max)
  - [ ] Work type (remote/hybrid/onsite)
  - [ ] Industry
- [ ] Exam configuration:
  - [ ] "Has Exam" checkbox
  - [ ] Passing score input (default 70)
  - [ ] Auto-rank candidates toggle
  - [ ] Max chat candidates input (default 5)
- [ ] Submit job:
  - [ ] `POST /api/jobs` called
  - [ ] Job data validated (Zod schema)
  - [ ] Job created in `jobPostings` table
  - [ ] If `hasExam = true`:
    - [ ] Exam created in `jobExams` table
    - [ ] Questions auto-generated via `generateExamQuestions()`
  - [ ] Auto-matching triggers:
    - [ ] `findMatchingCandidates()` called
    - [ ] Matches created in `jobMatches` table
    - [ ] Notifications sent to matched candidates
  - [ ] Activity log created
- [ ] Job appears in talent dashboard
- [ ] Success message shown

**API Endpoints to Verify:**
- `POST /api/jobs` - Creates job posting
- `storage.createJobPosting()` - Saves job
- `storage.createJobExam()` - Creates exam
- `findMatchingCandidates()` - Finds matches
- `storage.createJobMatch()` - Creates matches
- `notificationService.createNotification()` - Sends notifications

**Components to Verify:**
- `JobPostingWizard` component
- Form validation
- Exam question generation

**Common Issues to Check:**
- Job not saving (validation errors, database errors)
- Exam not creating
- Questions not generating
- Auto-matching not working
- Notifications not sent
- Form not submitting
- Required fields not validated

---

#### 10. Applicant Management
**Flow:** View Job → See Applicants → Review Applications → Update Status

**Test Steps:**
- [ ] Applicants list loads:
  - [ ] `GET /api/jobs/:jobId/applicants` called
  - [ ] All applicants for job returned
  - [ ] Application status shown
  - [ ] Exam scores shown (if applicable)
  - [ ] Candidate ranking shown
- [ ] View candidate profile:
  - [ ] Profile details display
  - [ ] Resume accessible
  - [ ] Skills, experience shown
- [ ] Update application status:
  - [ ] Status dropdown works
  - [ ] `PUT /api/applications/:applicationId/status` called
  - [ ] Status updated in database
  - [ ] Application event created
  - [ ] Notification sent to candidate
  - [ ] UI updates
- [ ] View exam results (if exam enabled):
  - [ ] Exam attempts listed
  - [ ] Scores displayed
  - [ ] Answers viewable
  - [ ] Ranking visible
- [ ] Chat with qualified candidates:
  - [ ] Chat button enabled for qualified candidates
  - [ ] Chat room accessible
  - [ ] Messages send/receive

**API Endpoints to Verify:**
- `GET /api/jobs/:jobId/applicants`
- `PUT /api/applications/:applicationId/status`
- `storage.getApplicantsForJob()`
- `storage.updateApplicationStatus()`
- `storage.createApplicationEvent()`

**Common Issues to Check:**
- Applicants not loading
- Status not updating
- Events not creating
- Notifications not sending
- Exam results not showing
- Chat not accessible

---

#### 11. Real-Time Notifications
**Flow:** Event Occurs → Notification Created → WebSocket Send → UI Update

**Test Steps:**
- [ ] WebSocket connection established:
  - [ ] Client connects to `/ws?userId=<userId>`
  - [ ] Connection added to `notificationService`
  - [ ] Heartbeat working (30s intervals)
- [ ] Notifications sent for:
  - [ ] New application received (talent owner)
  - [ ] Application viewed (candidate)
  - [ ] Application ranked (candidate)
  - [ ] Status updated (candidate)
  - [ ] New match (candidate)
  - [ ] Exam completed (talent owner)
  - [ ] New message (both)
- [ ] Notifications received in real-time:
  - [ ] WebSocket message received
  - [ ] Notification added to list
  - [ ] Badge count updates
  - [ ] Toast shown (if configured)
- [ ] Notification preferences respected:
  - [ ] Quiet hours checked
  - [ ] Type preferences checked
  - [ ] Priority filtering works
- [ ] Mark as read:
  - [ ] `PUT /api/notifications/:id/read` (or equivalent)
  - [ ] Notification marked read
  - [ ] Badge count decreases

**API Endpoints to Verify:**
- WebSocket endpoint `/ws`
- `notificationService.createNotification()`
- `notificationService.sendRealTimeNotification()`
- `GET /api/notifications`
- `PUT /api/notifications/:id/read`

**Components to Verify:**
- `RealTimeNotifications` component
- `NotificationCenter` component
- WebSocket hook (`useWebSocket` or `use-websocket-notifications`)

**Common Issues to Check:**
- WebSocket not connecting
- Notifications not sending
- Notifications not receiving
- Badge count not updating
- Preferences not working
- Mark as read not working

---

#### 12. Chat System
**Flow:** Qualified Candidate → Chat Access → Send Message → Receive Message

**Test Steps:**
- [ ] Chat access granted:
  - [ ] After exam qualification
  - [ ] Chat room created in `chatRooms` table
  - [ ] Access granted notification sent
- [ ] Chat interface loads:
  - [ ] `/chat/:id` route works
  - [ ] Chat room messages loaded
  - [ ] Participants shown
- [ ] Send message:
  - [ ] Message input works
  - [ ] `POST /api/chat/:roomId/messages` (or equivalent) called
  - [ ] Message saved to `chatMessages` table
  - [ ] WebSocket message sent
  - [ ] Message appears in UI
- [ ] Receive message:
  - [ ] WebSocket message received
  - [ ] Message added to chat
  - [ ] Notification sent (if user offline)
- [ ] Real-time updates work
- [ ] Message history loads

**API Endpoints to Verify:**
- `GET /api/chat/:roomId/messages`
- `POST /api/chat/:roomId/messages`
- `storage.createChatMessage()`
- `storage.getChatMessages()`
- WebSocket for real-time

**Components to Verify:**
- `Chat` page component
- `RealTimeChat` component
- `ChatInterface` component

**Common Issues to Check:**
- Chat room not created
- Messages not sending
- Messages not receiving
- WebSocket not working
- History not loading
- Access control issues

---

## 🔧 Debugging Checklist

### When Testing Each Use Case:

1. **Check API Endpoints:**
   - [ ] Endpoint exists in `server/routes.ts`
   - [ ] Authentication middleware applied (`isAuthenticated`)
   - [ ] Request validation (Zod schemas)
   - [ ] Error handling implemented
   - [ ] Response format correct

2. **Check Database:**
   - [ ] Tables exist (check `shared/schema.ts`)
   - [ ] Foreign key relationships correct
   - [ ] Data being saved correctly
   - [ ] Queries returning expected data
   - [ ] Indexes on frequently queried columns

3. **Check Frontend:**
   - [ ] Component renders
   - [ ] API calls made correctly
   - [ ] State management working (TanStack Query)
   - [ ] Error states handled
   - [ ] Loading states shown
   - [ ] User feedback (toasts) shown

4. **Check External Services:**
   - [ ] API keys configured (`.env`)
   - [ ] Rate limits not exceeded
   - [ ] Network connectivity
   - [ ] Service availability
   - [ ] Error responses handled

5. **Check Real-Time Features:**
   - [ ] WebSocket server running
   - [ ] Connections established
   - [ ] Messages sending/receiving
   - [ ] Heartbeat working
   - [ ] Reconnection logic

---

## 🐛 Common Error Patterns to Look For

1. **Authentication Issues:**
   - Session not persisting
   - Token expiration
   - Role not set correctly
   - Unauthorized access

2. **Database Issues:**
   - Foreign key violations
   - Missing required fields
   - Type mismatches
   - Constraint violations

3. **API Issues:**
   - Missing request body
   - Invalid data types
   - Validation failures
   - Missing error handling

4. **External API Issues:**
   - Missing API keys
   - Rate limit exceeded
   - Network timeouts
   - Invalid responses

5. **State Management Issues:**
   - Stale data
   - Cache not invalidating
   - Optimistic updates failing
   - Race conditions

---

## 📝 Testing Command Template

For each use case, test with:

```bash
# 1. Check server logs
# Watch server console for errors

# 2. Check browser console
# Open DevTools → Console tab

# 3. Check network requests
# DevTools → Network tab → Filter by API calls

# 4. Check database
# Query Supabase dashboard or use Drizzle Studio

# 5. Test API directly
curl -X GET http://localhost:5000/api/endpoint \
  -H "Authorization: Bearer <token>"

# 6. Check environment variables
# Ensure all required keys in .env file
```

---

## 🎯 Priority Fix Order

1. **Critical Paths:**
   - Candidate signup and profile setup
   - Resume upload and parsing
   - Job feed population
   - Job application submission

2. **High Priority:**
   - Talent owner job posting
   - Applicant management
   - Real-time notifications
   - Application status updates

3. **Medium Priority:**
   - Screening exams
   - Chat system
   - Layoff news
   - Analytics and insights

4. **Nice to Have:**
   - Advanced matching
   - Application intelligence
   - Market intelligence

---

## 💡 Quick Fix Commands

```bash
# Restart server
npm run dev:server:stop
npm run dev:server:start

# Clear database (if needed)
# Use reset-db.ts or manual SQL

# Check environment variables
cat .env | grep -E "(SUPABASE|GROQ|RAPIDAPI|NEWS_API)"

# Test specific endpoint
curl -X POST http://localhost:5000/api/candidate/resume \
  -F "resume=@test-resume.pdf" \
  -H "Authorization: Bearer <token>"

# Check WebSocket connection
# Use browser DevTools → Network → WS filter
```

---

Use this checklist systematically to identify and fix issues in each user journey. Start with the critical paths and work through each use case methodically.
