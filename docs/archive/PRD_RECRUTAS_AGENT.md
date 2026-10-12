# Product Requirements Document: Recrutas Agent - Browser-Based Job Application

## Executive Summary

Build an autonomous job application agent on top of OpenClaw (an open-source browser automation framework) that applies to external job postings on behalf of Recrutas users. The agent will intelligently fill out application forms, attach the user's uploaded resume, and complete the entire application process without manual intervention.

## Vision

Enable Recrutas users to scale their job search by automatically applying to relevant external job postings 24/7 while maintaining quality and personalization through intelligent form-filling and resume attachment.

## Goals & Objectives

1. **Automation**: Eliminate manual job application form filling for external job postings
2. **Scalability**: Allow users to apply to hundreds of jobs without manual effort
3. **Quality**: Ensure applications are completed accurately with user's resume and relevant information
4. **Transparency**: Provide clear visibility into which jobs were applied to and application status
5. **Integration**: Seamlessly integrate with Recrutas' existing job matching engine

## User Stories

### User Story 1: One-Click Job Application
**As a** Recrutas user
**I want to** apply to external job postings with a single click
**So that** I can scale my job search without manual effort

**Acceptance Criteria:**
- External job postings display an "Apply with Recrutas Agent" button
- Clicking the button triggers the application process
- The agent completes the entire application form automatically
- User's uploaded resume is attached to the application
- User receives confirmation of successful application

### User Story 2: Automatic Form Filling
**As a** Recrutas agent
**I want to** intelligently fill out job application forms
**So that** applications are submitted accurately without user intervention

**Acceptance Criteria:**
- Agent detects and fills standard form fields (name, email, phone, etc.)
- Agent handles various input types (text, dropdown, checkbox, file upload)
- Agent identifies required vs optional fields
- Agent uses user's profile data when available
- Agent skips fields that cannot be filled with confidence

### User Story 3: Resume Integration
**As a** Recrutas user
**I want to** automatically attach my uploaded resume to every application
**So that** employers receive my most current resume

**Acceptance Criteria:**
- Agent accesses the user's uploaded resume file
- Agent attaches resume to job applications automatically
- Agent handles various resume file formats (PDF, DOCX)
- Agent verifies resume was successfully attached before submission

### User Story 4: Application Tracking
**As a** Recrutas user
**I want to** see which jobs my agent has applied to
**So that** I know my application history and can follow up

**Acceptance Criteria:**
- Applications are logged with timestamp and job details
- Application status is tracked (pending, submitted, failed, error)
- User can view application history in Recrutas dashboard
- Failed applications show error details for manual intervention

## Technical Requirements

### Core Components

1. **Agent Engine**
   - Built on OpenClaw browser automation framework
   - Manages browser instance lifecycle
   - Handles JavaScript rendering and dynamic content loading
   - Manages session state and authentication

2. **Form Analyzer**
   - Detects and parses job application forms
   - Identifies form fields and their types
   - Determines required vs optional fields
   - Extracts form labels and placeholder text

3. **Form Filler**
   - Maps user profile data to form fields
   - Intelligently fills text fields (name, email, phone, address, etc.)
   - Handles dropdowns and select elements
   - Manages file uploads (resume attachment)
   - Handles checkboxes, radio buttons, text areas

4. **Resume Manager**
   - Stores and retrieves user's uploaded resume
   - Converts resume to appropriate format if needed
   - Handles multiple resume versions (future feature)
   - Validates resume file integrity

5. **Application Logger**
   - Records all application attempts
   - Captures form data submitted
   - Logs errors and failure reasons
   - Timestamps all activities

6. **Job Matcher Integration**
   - Receives job postings from Recrutas matching engine
   - Filters jobs for automatic application eligibility
   - Skips jobs requiring manual attention or additional info

### Technical Stack

- **Browser Automation**: OpenClaw (Node.js/Puppeteer based)
- **Language**: TypeScript
- **Database**: Existing Recrutas database for storing applications
- **API**: REST endpoints for agent communication
- **Queue System**: Job queue for managing application tasks (BullMQ or similar)
- **Error Handling**: Comprehensive logging and retry mechanisms

## Implementation Approach

### Phase 1: Foundation (Weeks 1-2)
1. Fork OpenClaw repository
2. Set up agent infrastructure and basic browser automation
3. Implement resume storage and retrieval
4. Create application logging system
5. Build API endpoints for agent communication

### Phase 2: Form Intelligence (Weeks 3-4)
1. Build form analyzer to detect form fields
2. Implement field type detection
3. Create mapping between user profile fields and form fields
4. Build form filler for common field types
5. Test on sample job posting forms

### Phase 3: Integration (Weeks 5-6)
1. Add "Apply with Recrutas Agent" button to job postings
2. Integrate with existing job matching system
3. Implement application tracking in dashboard
4. Build error handling and retry logic
5. Create user notifications and confirmations

### Phase 4: Polish & Launch (Week 7)
1. Comprehensive testing across multiple job sites
2. Error handling refinement
3. Documentation and user guides
4. Soft launch to beta users
5. Monitoring and optimization

## User Interface Changes

### External Job Posting Page
- Add prominent "Apply with Recrutas Agent" button next to "Apply" CTA
- Button includes loading state during application
- Shows success/error message after application attempt
- Provides quick access to application confirmation details

### Recrutas Dashboard
- New "Agent Applications" section showing:
  - List of applications submitted by agent
  - Application status (submitted, failed)
  - Job title, company, application date
  - Filter/sort capabilities
  - Error details for failed applications
  - Reapply option for failed attempts

## Data Flow

```
User clicks "Apply with Recrutas Agent"
    ↓
Agent receives job posting URL and user ID
    ↓
Agent navigates to job posting page
    ↓
Agent analyzes form structure
    ↓
Agent retrieves user resume and profile data
    ↓
Agent fills form fields intelligently
    ↓
Agent attaches resume file
    ↓
Agent submits application
    ↓
Agent logs application result
    ↓
Dashboard updated with new application
    ↓
User receives notification
```

## Success Metrics

1. **Application Success Rate**: % of jobs successfully applied to vs total attempts
2. **Form Fill Accuracy**: % of forms with all required fields filled correctly
3. **Time to Apply**: Average time from job posting to successful application submission
4. **User Adoption**: % of Recrutas users using agent feature
5. **Application Efficiency**: Total applications per user per day (should increase 10x+)
6. **Error Rate**: % of applications failing due to form complexity or errors
7. **Resume Attachment Success**: % of applications with resume successfully attached

## Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Form complexity varies widely across job sites | High | Implement fallback to manual fill; capture form screenshots for review |
| JavaScript-heavy forms break automation | Medium | Use OpenClaw's JS rendering; implement retry with longer wait times |
| Resume format compatibility issues | Medium | Support PDF and DOCX; test across common ATS systems |
| Rate limiting/bot detection by job sites | High | Implement realistic delays between actions; rotate user agents; monitor for blocks |
| User profile data insufficient for some forms | Medium | Allow user to specify default answers; skip optional fields; manual intervention option |
| Resume privacy/security concerns | High | Encrypt resume in transit and at rest; audit all resume access; clear user communication |
| Application quality suffers | High | Start with high-match jobs only; manual review of sample applications; user feedback loop |

## Future Enhancements (Post-MVP)

1. **Multiple Resume Support**: Allow users to select different resumes for different job types
2. **Custom Answers**: Store and reuse common text answers for frequently asked questions
3. **Cover Letter Generation**: AI-generated cover letters based on job posting
4. **Smart Job Filtering**: Only apply to jobs matching user's criteria (salary, location, role)
5. **Interview Scheduling**: Auto-schedule interviews when links provided
6. **Application Analytics**: Track callback rates and provide insights
7. **Multi-site Support**: Prioritize specific job boards for automation

## Dependencies

- OpenClaw repository access and maintenance
- Recrutas backend API modifications for application logging
- Recrutas job matching engine integration
- User resume storage system
- Dashboard UI updates
- Email/notification system for user confirmations

## Success Criteria for Launch

- Agent successfully applies to 95%+ of job postings
- Form fill accuracy above 90% for common fields
- Zero privacy/security issues in resume handling
- User feedback validates feature improves job search efficiency
- No significant impact on job site performance or rate limiting
- Documentation complete and user-ready
