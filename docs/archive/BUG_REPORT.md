# Code Review Bug Report - Recrutas Platform

> **Last reviewed:** March 2026
> **Reviewer:** Senior Engineer
> **Status key:** ✅ Fixed | ❌ Open | ⚠️ Accepted risk | 🚫 Not a bug

---

## CRITICAL

### 1. Null Email Access Crash
**File:** `client/src/components/real-time-chat.tsx:260`
**Status:** ✅ Fixed in `96ecc7a`

`message.sender.email[0]` → `message.sender.email?.[0]?.toUpperCase() || '?'`

---

### 2. Job Matching Background Job Broken (`candidateId` field mismatch)
**File:** `server/storage.ts:1097`, `server/routes.ts:192`
**Status:** ✅ Fixed in `7ca2353`

`findMatchingCandidates` returned `id: user.id` but `createJobMatch` requires
`candidateId: uuid NOT NULL`. Every new-job background match silently failed;
notifications fired to `undefined`. Field renamed to `candidateId`.

---

## HIGH

### 3. Sequential AI Scoring (N+1 pattern)
**File:** `server/storage.ts:1093`
**Status:** ✅ Fixed in `7ca2353`

50 sequential `await generateJobMatch()` calls in a `for` loop replaced with
`Promise.all` batches of 10 (~10× faster).

---

### 4. Unauthenticated Scrape Trigger
**File:** `server/routes.ts:855`
**Status:** ✅ Fixed in `7ca2353`

`GET /api/external-jobs?triggerRefresh=true` had no auth — any anonymous caller
could queue unlimited background scrapes. Now gated behind `req.user`.

---

### 5. Missing Status Validation on Application Updates
**File:** `server/routes.ts:1692`
**Status:** ✅ Fixed (pre-existing, verified present)

Enum validation against `VALID_APPLICATION_STATUSES` was already in place.

---

### 6. Missing Auth Check on Notification Read
**File:** `server/routes.ts` → `notification-service.ts`
**Status:** ✅ Fixed (pre-existing, verified present)

`markAsRead` filters `WHERE notifications.userId = req.user.id` at the DB layer.

---

### 7. External Jobs Error Returns 200
**File:** `server/routes.ts:867`
**Status:** ✅ Fixed (pre-existing, verified present)

Catch block already returns `res.status(503)`.

---

### 8. Unhandled Promise Chains
**File:** `server/routes.ts:477, 532, 2123, 2150, 2196`
**Status:** ✅ Fixed (pre-existing, verified present)

All five chains have `.catch()` handlers.

---

### 9. Unvalidated Query Params on Public Endpoint
**File:** `server/routes.ts:841`
**Status:** ✅ Fixed in `b4bfa86`

`jobTitle`/`location` were passed unbounded into `LOWER(col) LIKE LOWER('%<input>%')`
DB queries. Capped: `jobTitle`/`location` at 200 chars, each skill at 100 chars,
skill list at 20 entries.

---

### 10. Rate Limiting
**File:** `server/index.ts`
**Status:** ⚠️ Accepted risk

Global limiter exists: 100 req/15min per IP. Auth endpoints: 10 req/15min.
Adequate for current scale. Revisit when traffic justifies stricter per-route limits.

---

### 11. CORS Allows All `*.vercel.app`
**File:** `server/index.ts:110`
**Status:** ⚠️ Accepted risk

App uses JWT auth headers (not cookies), so CORS does not protect against CSRF.
The wildcard has no meaningful attack surface given the auth model. Restrict to
named Vercel subdomains if cookies are ever introduced.

---

## MEDIUM

### 12. Auth Race Condition in RoleGuard
**File:** `client/src/components/role-guard.tsx`
**Status:** ✅ Fixed (pre-existing)

`isLoading` from `useSessionContext` gates role check before profile resolves.

---

### 13. `setInterval` Without Cleanup in NotificationService
**File:** `server/notification-service.ts:574`
**Status:** ✅ Fixed in `2035736`

Handles stored in `heartbeatIntervals[]`. `startHeartbeat()` guarded against
double-init. `stopHeartbeat()` added for clean teardown.

---

### 14. Silent Empty Catches in Agent-Apply
**File:** `server/services/agent-apply.service.ts`
**Status:** ✅ Fixed in `eeff2a3`

14 empty `.catch(() => {})` blocks audited and categorised:
- `waitForLoadState('networkidle')` — kept silent, comment added (expected on SPAs)
- `waitForSelector` for form fields — now calls `addLog()` so failures appear in attempt log
- Workday iframe selector — `addLog()` warning added
- `selectOption` fallback — `console.warn` added
- `browser.close()` / `fs.unlink()` — kept silent (teardown)

---

### 15. Missing DB Indexes
**File:** `shared/schema.ts`
**Status:** ✅ Fixed (pre-existing, verified present)

Indexes confirmed: `idx_application_candidate`, `idx_application_job_id`,
`idx_notification_user`.

---

### 16. Duplicate `useEffect` WebSocket Cleanup
**File:** `client/src/hooks/use-websocket-notifications.ts`
**Status:** 🚫 Not a bug — single `useEffect` with single cleanup, no duplication.

---

## LOW / NOISE

| # | Issue | Verdict |
|---|-------|---------|
| 17 | 1405+ `any` types | Noise — ESLint already tracks all instances as warnings |
| 18 | Background job queue (BullMQ) | Architectural debt — `setTimeout` intentional for serverless; needs Redis to fix |
| 19 | JWT payload `as any` | Minor style — no runtime risk given HS256 validation |
| 20 | API response format inconsistency | Style — frontend already handles all shapes |
| 21 | Verbose error messages in production | Controlled by `NODE_ENV` check; internal throws don't reach HTTP responses |
| 22 | `console.log` in production | Acceptable at current scale; migrate to pino when needed |
| 23 | Magic numbers | Already named constants (`MATCHING_TIMEOUT_MS`, etc.) |
| 24 | Duplicate `sleep()` implementations | Style — one-liner DRY refactor, not a bug |
| 25 | Inconsistent import ordering | Style — ESLint rule can enforce |
| 26 | Sensitive data in logs (user IDs) | Normal practice; user IDs are not PII |
| 27 | File size (2400-line files) | Tech debt — split into domain modules when team grows |
| 28 | Missing pagination | Feature request, not a bug |
| 29 | `key={i}` on string list | `q` is a `string`, has no `.id` — index key is correct here |
| 30 | Missing `useEffect` deps | Hypothetical code in report — not present in actual codebase |
| 31 | No load / chaos tests | Backlog |

---

## OPEN ITEMS

None. All verified bugs are fixed. Remaining items are accepted risks or backlog.

---

*Updated: March 2026*
