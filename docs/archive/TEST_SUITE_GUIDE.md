# Comprehensive Automated Test Suite Guide

## Overview

This test suite implements end-to-end coverage for the Recrutas platform, following the complete user journey from resume upload through AI parsing, job matching, and feed display.

### Test Architecture

The suite is organized into **5 phases** following the testing pyramid:
- **Phase 1**: Test infrastructure and fixtures
- **Phase 2**: Backend unit tests (70% of pyramid)
- **Phase 3**: Backend integration tests (25% of pyramid)
- **Phase 4**: Frontend component tests
- **Phase 5**: End-to-end flow tests (5% of pyramid)

## File Organization

```
test/
├── helpers/
│   ├── async-helpers.js          # Polling, waitFor, retryWithBackoff
│   └── test-data-factory.js      # Factory functions for test data
├── fixtures/
│   ├── fixture-generator.js      # PDF/DOCX generation utilities
│   ├── expected-outputs.json     # Expected parsed outputs
│   └── sample-jobs.json          # Pre-built job test data
├── test-utils.js                 # Auth helpers, user creation/deletion
│── ai-resume-parser-unit.test.js
├── advanced-matching-unit.test.js
├── resume-service-integration.test.js
├── job-matching-integration.test.js
├── resume-upload-api.test.js
└── e2e-resume-to-feed.test.js

client/src/
├── __tests__/
│   └── AIJobFeed.test.tsx        # Frontend component tests
└── mocks/
    └── handlers.ts               # MSW API mocks (updated)
```

## Running Tests

### Individual Test Suites

```bash
# Backend unit tests (30s)
npm run test:unit:backend

# Backend integration tests (2min, requires running server)
npm run test:integration:backend

# Frontend component tests (1min)
npm run test:frontend

# E2E flow tests (5min, requires full stack)
npm run test:e2e

# All tests
npm run test:all

# Coverage report
npm run test:coverage
```

### Test Requirements

| Suite | Requirements | Duration |
|-------|--------------|----------|
| **Unit** | None | ~30s |
| **Integration** | Running server + Supabase | ~2min |
| **Frontend** | None | ~1min |
| **E2E** | Full stack running | ~5min |

## Test Coverage Details

### Phase 2: Backend Unit Tests

#### `ai-resume-parser-unit.test.js` (20 tests)
Tests extraction logic in isolation, without database or API calls.

**Key Coverage:**
- Skills extraction from PDFs, DOCX, and text
- Personal info extraction (name, email, phone, LinkedIn, GitHub)
- Experience level detection (entry/mid/senior/lead/executive)
- Education and certification extraction
- Confidence scoring (90%+ for complete, 60-80% for partial, <50% for minimal)
- Special character and accent handling
- Error handling (malformed PDFs, unsupported formats)

**Critical Test Scenarios:**
```javascript
// Skills from well-formatted PDF
✅ testSkillsExtractionFromCompletePdf

// Resume with no skills section
✅ testHandlesNoSkillsSection

// Malformed PDF graceful handling
✅ testMalformedPdfHandling

// Confidence calculation
✅ testConfidenceScoreHighForComplete     (≥0.85)
✅ testConfidenceScoreLowForMinimal       (0.5-0.85)
```

#### `advanced-matching-unit.test.js` (18 tests)
Tests hybrid matching algorithm with weighted scoring in isolation.

**Hybrid Formula (45/25/20/10):**
```
FinalScore = 0.45*Semantic + 0.25*Recency + 0.20*Liveness + 0.10*Personalization
```

**Key Coverage:**
- Semantic relevance scoring (skill/experience match)
- Recency scoring (newer jobs rank higher)
- Liveness scoring (active jobs > stale jobs)
- Personalization scoring (user behavior signals)
- Minimum threshold filtering (60% cutoff)
- Result caching (60-second TTL)
- Trust badges (isVerifiedActive, isDirectFromCompany)

**Critical Test Scenarios:**
```javascript
// Core formula verification
✅ testHybridFormulaWeighting           (weights = 0.45+0.25+0.20+0.10)

// Badge logic
✅ testVerifiedActiveBadge              (trustScore ≥ 85 + active)
✅ testDirectFromCompanyBadge           (internal jobs)

// Edge cases
✅ testLargeCandidateSkillSet           (50+ skills)
✅ testNoCommonSkillsHandling           (score < 0.6)
```

### Phase 3: Backend Integration Tests

#### `resume-service-integration.test.js` (13 tests)
Tests resume service with real database and background processing.

**Key Coverage:**
- Resume upload completes in <2 seconds
- Resume URL stored in database immediately
- Background AI parsing triggered (fire-and-forget)
- Background parsing completes within 45 seconds
- Skills extracted and saved to profile
- Experience level set
- Activity log records parsing completion
- Concurrent uploads handled (3+ simultaneous)
- Malformed PDF handling
- File size validation (reject >5MB)

**Critical Test Scenarios:**
```javascript
// Fast upload + async processing
✅ testResumeUploadCompletesQuickly      (<2s response)

// Background processing validation
✅ testBackgroundParsingCompletion      (waits for profile update)
✅ testActivityLogRecordsParsingCompletion  (checks activity logs)

// Database state verification
✅ testSkillsExtractedCorrectly         (checks candidateProfiles.skills)
✅ testExperienceLevelExtraction        (checks candidateProfiles.experience)

// Error handling
✅ testMalformedPdfHandling
✅ testParsingFailureHandling
✅ testFileSizeValidation               (>5MB rejected)
```

#### `job-matching-integration.test.js` (11 tests)
Tests matching flow from profile to recommendations.

**Key Coverage:**
- Automatic matching after resume upload
- Profile updates trigger re-matching
- Hybrid formula ranking validation
- Skill matches highlighted
- Trust badges displayed
- Job details included in recommendations
- Empty matches when candidate has no skills
- Large skill sets handled (50+ skills)
- No common skills edge case
- Pagination works

**Critical Test Scenarios:**
```javascript
// Complete flow
✅ testAutomaticMatchingAfterResumeUpload    (upload → parse → match)

// Ranking validation
✅ testRankingByHybridFormula               (new internal > old external)

// Feature display
✅ testSkillMatchHighlighting               (shows matching skills)
✅ testVerifiedActiveBadgeDisplay           (badge appears)

// Edge cases
✅ testEmptyMatchesWhenNoSkills
✅ testLargeSkillSetHandling                (50+ skills)
```

#### `resume-upload-api.test.js` (17 tests)
Tests API endpoint validation and response structure.

**Key Coverage:**
- Accept PDF and DOCX files
- Reject unsupported types (.exe, .txt)
- Reject files >5MB
- Validate magic bytes
- Require valid Bearer token
- Reject missing token
- Response contains resumeUrl
- Response contains parsed=false (async)
- Response contains aiParsing=true
- Response contains extractedInfo=null initially
- Case-insensitive file extensions

**Critical Test Scenarios:**
```javascript
// Authentication
✅ testRequireValidBearerToken           (401 on invalid)
✅ testRejectMissingToken                (401 on missing)

// File validation
✅ testAcceptPdfFiles
✅ testAcceptDocxFiles
✅ testRejectUnsupportedTypes            (.exe rejected)
✅ testRejectFilesOver5MB

// Response structure
✅ testResponseStructure                 (all fields present)
✅ testResponseContainsParsedFlag        (parsed=false)
✅ testResponseContainsAiParsingFlag     (aiParsing=true)
```

### Phase 4: Frontend Tests

#### `AIJobFeed.test.tsx` (25 tests)
Tests job feed UI with full interaction patterns.

**Key Coverage:**
- Component renders without errors
- Loading state displayed
- Job matches displayed with titles, companies, locations
- Match scores shown (0-100%)
- AI explanations displayed
- Skill matches shown as badges
- Trust badges (Verified Active, Direct from Company)
- Search filtering works
- Location filtering works
- Work type filtering works
- Company filtering works

**User Interactions:**
- Apply to job (button state changes to "Applied")
- Save job (toggles "Save"/"Unsave")
- Hide job (removes from feed)
- View match breakdown (modal opens/closes)
- Virtual scrolling for large datasets
- Pagination (Load More button)

**Critical Test Scenarios:**
```javascript
// Rendering
✅ testRendersJobFeedComponent
✅ testDisplaysLoadingState
✅ testDisplaysJobMatches                (title, company, location)

// Features
✅ testDisplaysMatchScores               (0-100%)
✅ testDisplaysAIExplanations
✅ testDisplaysSkillMatchesAsBadges

// Badges
✅ testDisplaysVerifiedActiveBadge
✅ testDisplaysDirectFromCompanyBadge

// Interactions
✅ testAllowsApplyingToJob               (state: "Applied")
✅ testAllowsSavingJob                   (state: "Unsave")
✅ testAllowsUnsavingJob
✅ testAllowsHidingJob                   (removed from feed)
✅ testDisplaysMatchBreakdownModal       (opens/closes)

// Filtering
✅ testAllowsFilteringBySearchTerm
✅ testAllowsFilteringByLocation
✅ testAllowsFilteringByWorkType

// Edge cases
✅ testDisplaysEmptyStateWhenNoMatches
✅ testHandlesMultipleUserActionsOnSameJob
```

**MSW Mocks (client/src/mocks/handlers.ts):**
- `GET /api/ai-matches` - Returns job matches with optional filtering
- `GET /api/candidate/job-actions` - Returns saved/applied jobs
- `POST /api/candidate/apply/:jobId` - Track application
- `POST /api/candidate/saved-jobs` - Save job
- `DELETE /api/candidate/saved-jobs/:jobId` - Unsave job
- `POST /api/candidate/hidden-jobs` - Hide job

### Phase 5: End-to-End Tests

#### `e2e-resume-to-feed.test.js` (6 tests)
Tests complete user journeys with 60-second timeout.

**Complete Flow Test:**
```
1. Create test user
2. Upload resume via POST /api/candidate/resume
3. Wait for background AI parsing (max 45s)
4. Verify profile updated with skills
5. Verify activity log records completion
6. Create matching job
7. Fetch recommendations
8. Verify match details (score, explanation, badges)
9. Apply to job
10. Verify application tracked
```

**Test Scenarios:**
```javascript
// Main flow
✅ testCompleteE2EFlow
   - Resume upload → parsing → matching → application

// Variants
✅ testE2EWithMultipleJobs              (3 jobs, multiple matches)
✅ testE2EWithMinimalResume             (2 skills, limited data)
✅ testE2EManualProfileUpdate           (no resume, profile API)
✅ testE2EJobFiltering                  (location, workType filters)
✅ testE2EConcurrentApplications        (3 parallel applies)
```

## Test Data and Fixtures

### Fixture Generators (`test/fixtures/fixture-generator.js`)

```javascript
// PDF generation
generateCompletePdfBuffer()       // Full resume (all sections)
generateMinimalResumePdfBuffer()  // Basic (name + 2 skills)
generateNoSkillsPdfBuffer()       // Missing skills section
generateMalformedPdfBuffer()      // Corrupted file
generateLargePdfBuffer()          // 5MB+ file
generateDocxBuffer()              // DOCX format

// Unsupported formats
generateUnsupportedFileBuffer()   // .exe file signature
generateTextFileBuffer()          // Plain text
```

### Test Data Factory (`test/helpers/test-data-factory.js`)

```javascript
// Core objects
createSampleJob(overrides)               // Job posting
createCandidateProfile(overrides)        // Candidate profile
createParsedResumeData(overrides)        // Extracted resume data
createJobMatch(overrides)                // Match result
createAdvancedMatch(overrides)           // Full hybrid score

// Collections
createMockJobsForFeed(count, overrides)  // N jobs for feed testing

// Domain objects
createScreeningQuestion(overrides)
createExamAttempt(overrides)
createJobApplication(overrides)
createActivityLogEntry(overrides)
```

### Async Helpers (`test/helpers/async-helpers.js`)

```javascript
// Core polling
waitForCondition(condition, timeout, pollInterval)

// Domain-specific
waitForActivityLogEvent(getActivityLogs, eventName, timeout)
waitForProfileUpdate(getProfile, expectedProperties, timeout)

// Retry logic
retryWithBackoff(operation, maxRetries, initialDelayMs)

// Utility
delay(ms)
```

## Test Utilities (`test/test-utils.js`)

```javascript
// User management
createNewUserAndGetToken()               // Create test candidate
createNewTalentOwnerAndGetToken()        // Create test recruiter
deleteUser(userId)                       // Cleanup

// Data access
getUser(userId)
getCandidateProfile(userId)
getActivityLogs(userId)
clearTestData()                          // Danger: delete all test users

// Wait primitives
waitFor(condition, timeout)
```

## Key Testing Patterns

### 1. Authentication
```javascript
const { token, userId } = await createNewUserAndGetToken();

const res = await request
  .post('/api/candidate/resume')
  .set('Authorization', `Bearer ${token}`)
  .attach('resume', pdfBuffer, 'resume.pdf');
```

### 2. Background Processing
```javascript
// Upload fires background job
const uploadRes = await request.post('/api/candidate/resume')
  .set('Authorization', `Bearer ${token}`)
  .attach('resume', pdfBuffer, 'resume.pdf');

// Wait for completion
const profile = await waitForProfileUpdate(
  async () => {
    const { data } = await supabase
      .from('candidateProfiles')
      .select('*')
      .eq('userId', userId)
      .single();
    return data;
  },
  { resumeParsed: true },
  45000  // 45 second timeout
);
```

### 3. Activity Log Verification
```javascript
const event = await waitForActivityLogEvent(
  async () => {
    const { data } = await supabase
      .from('activityLogs')
      .select('*')
      .eq('userId', userId)
      .order('createdAt', { ascending: false });
    return data || [];
  },
  'resume_parsing_complete',
  45000
);
```

### 4. Frontend Testing with MSW
```javascript
describe('AIJobFeed', () => {
  it('displays job matches', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <AIJobFeed />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('job-match-1')).toBeInTheDocument();
    });
  });
});
```

## Success Criteria

### Coverage Targets
- ✅ Backend: 85%+ overall, 95%+ for critical paths
- ✅ Frontend: 80%+ for components, 90%+ for critical flows

### Quality Metrics
- ✅ All tests deterministic (no flaky tests)
- ✅ Fast execution: Unit <30s, Integration <2min, E2E <5min
- ✅ Clear failure messages with descriptive assertions
- ✅ Full isolation (tests don't depend on each other)
- ✅ Proper cleanup (delete users, clear cache)

### Validation Checklist
- ✅ Resume upload validates file types, size, magic bytes
- ✅ Background AI parsing completes and updates profile
- ✅ AI parser extracts all resume sections with confidence
- ✅ Hybrid matching applies correct weights (45/25/20/10)
- ✅ Trust badges displayed correctly
- ✅ Job feed filters work (search, location, workType)
- ✅ User actions work (apply, save, hide)
- ✅ Virtual scrolling handles large datasets
- ✅ Edge cases handled (parsing failures, no matches)
- ✅ Full E2E: upload → parse → match → apply

## Debugging Failed Tests

### 1. Check Test Logs
```bash
npm run test:unit:backend -- --verbose
npm run test:integration:backend -- --verbose
npm run test:frontend -- --reporter=verbose
```

### 2. Run Single Test
```bash
# Run one unit test file
NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest test/ai-resume-parser-unit.test.js

# Run one test in Vitest
npm run test:frontend -- --grep "displays job matches"
```

### 3. Debug Database Issues
```javascript
// Check if test user exists
const { data: users } = await supabase.auth.admin.listUsers();
console.log(users);

// Check profile
const { data: profile } = await supabase
  .from('candidateProfiles')
  .select('*')
  .eq('userId', userId);
console.log(profile);
```

### 4. Check Server Logs
Integration and E2E tests require running server:
```bash
npm run dev:server-no-watch
# Then in another terminal:
npm run test:integration:backend
```

## Continuous Integration

For CI/CD pipelines, run tests in order:

```bash
# Fast feedback (parallel)
npm run test:unit:backend
npm run test:frontend

# Integration (requires server)
npm run test:integration:backend

# E2E (full stack)
npm run test:e2e

# Coverage report
npm run test:coverage
```

### GitHub Actions Example
```yaml
- name: Run unit tests
  run: npm run test:unit:backend

- name: Run frontend tests
  run: npm run test:frontend

- name: Start server
  run: npm run dev:server-no-watch &

- name: Run integration tests
  run: npm run test:integration:backend

- name: Run E2E tests
  run: npm run test:e2e

- name: Generate coverage
  run: npm run test:coverage
```

## Maintenance and Updates

### Adding New Tests
1. Follow existing naming patterns (`*-unit.test.js`, `*-integration.test.js`)
2. Use factory functions from `test-data-factory.js`
3. Use async helpers from `async-helpers.js`
4. Clean up in `finally` blocks
5. Add descriptive assertions

### Updating Fixtures
1. Edit `fixture-generator.js` for file generation
2. Update `expected-outputs.json` for expected results
3. Run affected tests to verify
4. Document changes in comments

### Mock Updates
1. Update `client/src/mocks/handlers.ts` for new endpoints
2. Ensure handlers match actual API responses
3. Add query parameter support for filtering
4. Test with frontend suite before commit

## Performance Considerations

### Test Optimization
- Unit tests: No I/O, pure functions → ~30s
- Integration: Real database calls, network latency → ~2min
- Frontend: React rendering, DOM queries → ~1min
- E2E: Full stack, waiting for background jobs → ~5min

### Timeout Tuning
- Resume parsing: 45 seconds (allows for AI processing)
- Activity log polling: 30 seconds
- General wait conditions: 10 seconds
- API requests: 5 seconds

## Future Enhancements

- [ ] Performance benchmarking tests
- [ ] Load testing (concurrent candidates)
- [ ] Accessibility testing (a11y)
- [ ] Visual regression testing
- [ ] API contract testing (OpenAPI)
- [ ] Database migration tests

---

**Last Updated:** 2026-01-31
**Test Suite Version:** 1.0
**Total Test Count:** 100+ tests across 6 test files
