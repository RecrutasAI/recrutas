/**
 * Drive the full core product loop end-to-end against the real DB,
 * exercising the SAME service/storage code paths the HTTP routes use.
 *
 * Loop:  employer posts internal job  →  exam generated  →  candidate applies
 *        (pending_exam)  →  candidate submits exam  →  ranking grants chat access
 *        →  chat room created  →  both parties exchange messages.
 *
 * It does NOT hit HTTP — it calls storage + ExamService directly, which is what
 * the routes do (routes.ts:2018 → examService.submitExam, etc.). This validates
 * the wiring, not the auth/transport layer.
 *
 * ⚠️  This writes to the PRODUCTION database. By default it CLEANS UP everything
 *     it created at the end. Pass --keep to leave the rows for manual UI inspection.
 *
 * Usage:
 *   npx tsx scripts/drive-core-loop.ts            # run loop, then delete test data
 *   npx tsx scripts/drive-core-loop.ts --keep     # run loop, leave test data in DB
 */

import { randomUUID } from "crypto";
import { db, client } from "../server/db.js";
import { users, candidateProfiles, jobApplications, chatRooms, chatMessages, jobExams, examAttempts, jobPostings } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm/sql";
import { inArray } from "drizzle-orm/sql/expressions";
import { storage } from "../server/storage.js";
import { notificationService } from "../server/notification-service.js";
import { ExamService } from "../server/services/exam.service.js";

const KEEP = process.argv.includes("--keep");

// Same ExamService the routes construct (routes.ts:95)
const examService = new ExamService(storage, notificationService);

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

// Deterministic exam: 3 multiple-choice questions. correctAnswer is an index;
// calculateScoreWithDetails gives full credit when the selected option index
// is >= correctAnswer (exam.service.ts:173-175).
const EXAM_QUESTIONS = [
  { id: "q1", type: "multiple-choice", text: "Which keyword declares a block-scoped variable in JS?", options: ["var", "let"], correctAnswer: 1, points: 10 },
  { id: "q2", type: "multiple-choice", text: "What does SQL stand for?", options: ["Wrong", "Structured Query Language"], correctAnswer: 1, points: 10 },
  { id: "q3", type: "multiple-choice", text: "Big-O of binary search?", options: ["O(n)", "O(log n)"], correctAnswer: 1, points: 10 },
];
// Answers that earn 100%. The real exam UI (job-exam.tsx) submits the selected
// option's 0-based index as a string, so mirror that exact encoding here — using
// option text instead would mask the index/text mismatch this script exists to catch.
const CORRECT_ANSWERS = { q1: "1", q2: "1", q3: "1" };

async function main() {
  console.log("=== Driving the core product loop end-to-end ===\n");
  console.log(KEEP ? "(--keep: test data will remain in the DB)\n" : "(test data will be cleaned up at the end; pass --keep to retain)\n");

  const ownerId = randomUUID();
  const candidateId = randomUUID();
  const stamp = Date.now();

  // ---- Setup: one employer + one candidate (FK prerequisites) ----
  await db.insert(users).values({ id: ownerId, email: `loop-test-owner+${stamp}@recrutas.test`, name: "Loop Owner", firstName: "Loop", lastName: "Owner", role: "talent_owner" } as any);
  await db.insert(users).values({ id: candidateId, email: `loop-test-cand+${stamp}@recrutas.test`, name: "Loop Candidate", firstName: "Loop", lastName: "Candidate", role: "candidate" } as any);
  await db.insert(candidateProfiles).values({ userId: candidateId, skills: ["JavaScript", "SQL", "Algorithms"], experience: "5 years", workType: "remote" });
  console.log(`Setup: employer=${ownerId.slice(0, 8)} candidate=${candidateId.slice(0, 8)}\n`);

  // ===== STEP 1: employer posts an internal job (no externalUrl) =====
  console.log("STEP 1 — employer posts internal job (storage.createJobPosting)");
  const job = await storage.createJobPosting({
    talentOwnerId: ownerId,
    title: "Core Loop Test Engineer",
    company: "Recrutas Internal",
    description: "Validating the match→exam→chat pipeline end to end.",
    skills: ["JavaScript", "SQL", "Algorithms"],
    location: "Remote",
    workType: "remote",
    status: "active",
    hasExam: true,
    autoRankCandidates: true,
    maxChatCandidates: 5,
    // no externalUrl → source defaults to 'platform' → treated as internal
  } as any);
  const freshJob = await storage.getJobPosting(job.id);
  check("job created", !!freshJob, `id=${job.id}`);
  const isInternal = !freshJob!.externalUrl && (freshJob!.source === "platform" || freshJob!.source === "internal" || !freshJob!.source);
  check("job is loop-eligible (isInternal && hasExam)", isInternal && !!freshJob!.hasExam, `source=${freshJob!.source} externalUrl=${freshJob!.externalUrl ?? "null"} hasExam=${freshJob!.hasExam}`);

  // ===== STEP 2: exam generated (routes does this async; we call createJobExam directly) =====
  console.log("\nSTEP 2 — exam generated (storage.createJobExam)");
  await storage.createJobExam({ jobId: job.id, title: `${job.title} Assessment`, passingScore: 70, questions: EXAM_QUESTIONS });
  const exam = await storage.getJobExam(job.id);
  check("exam exists for job", !!exam, `examId=${exam?.id} questions=${exam?.questions?.length}`);

  // ===== STEP 3: candidate applies → status pending_exam (mirrors routes.ts:1437 logic) =====
  console.log("\nSTEP 3 — candidate applies (apply-route logic)");
  const applyStatus = isInternal && freshJob!.hasExam ? "pending_exam" : "submitted";
  const [application] = await db.insert(jobApplications).values({ jobId: job.id, candidateId, status: applyStatus }).returning();
  check("application routed to pending_exam (not submitted)", application.status === "pending_exam", `status=${application.status}`);

  // ===== STEP 4 + 5: candidate submits exam → ExamService ranks + grants chat =====
  console.log("\nSTEP 4+5 — candidate submits exam (examService.submitExam → rank → grantChatAccess)");
  const result = await examService.submitExam(job.id, candidateId, CORRECT_ANSWERS);
  check("exam scored", typeof result.score === "number", `score=${result.score}%`);
  check("candidate passed", result.passed === true, `passed=${result.passed}`);
  check("ranking computed", result.ranking >= 1, `rank=${result.ranking}/${result.totalCandidates}`);
  check("qualifiedForChat true", result.qualifiedForChat === true, `qualifiedForChat=${result.qualifiedForChat}`);

  const [attempt] = await db.select().from(examAttempts).where(eq(examAttempts.jobId, job.id));
  check("exam_attempt persisted (completed)", !!attempt && attempt.status === "completed", `status=${attempt?.status} passedExam=${attempt?.passedExam} qualifiedForChat=${attempt?.qualifiedForChat}`);
  const promotedApp = await storage.getApplicationByJobAndCandidate(job.id, candidateId);
  check("application promoted pending_exam → submitted", promotedApp?.status === "submitted", `status=${promotedApp?.status}`);

  // ===== STEP 6: chat room created and reachable by both parties =====
  console.log("\nSTEP 6 — chat room created (storage.getChatRoomsForUser)");
  const candRooms = await storage.getChatRoomsForUser(candidateId);
  const ownerRooms = await storage.getChatRoomsForUser(ownerId);
  const room = candRooms.find((r) => r.jobId === job.id);
  check("chat room visible to candidate", !!room, room ? `roomId=${room.id} rank=${room.candidateRanking}` : "none");
  check("chat room visible to employer", ownerRooms.some((r) => r.jobId === job.id), `ownerRooms=${ownerRooms.length}`);

  // ===== STEP 7: both parties exchange messages =====
  console.log("\nSTEP 7 — direct chat messages (storage.createChatMessage)");
  if (room) {
    await storage.createChatMessage({ chatRoomId: room.id, senderId: ownerId, message: "Hi! Strong exam — want to chat about the role?" } as any);
    await storage.createChatMessage({ chatRoomId: room.id, senderId: candidateId, message: "Absolutely, thanks! When works for you?" } as any);
    const msgs = await storage.getChatMessages(room.id);
    check("messages stored both directions", msgs.length >= 2, `messages=${msgs.length}`);
  } else {
    check("messages stored both directions", false, "no room — skipped");
  }

  // ---- Cleanup ----
  // NOTE: prod FKs do NOT honor the ON DELETE CASCADE declared in shared/schema.ts,
  // so we delete every child row explicitly, in dependency order. notifications
  // created by examService.submitExam reference job_applications and must go first.
  if (!KEEP) {
    console.log("\nCleaning up test data...");
    await db.execute(sql.raw(
      `DELETE FROM notifications WHERE user_id IN ('${ownerId}','${candidateId}') ` +
      `OR related_job_id = ${job.id} ` +
      `OR related_application_id IN (SELECT id FROM job_applications WHERE job_id = ${job.id})`
    ));
    if (room) {
      await db.delete(chatMessages).where(eq(chatMessages.chatRoomId, room.id));
      await db.delete(chatRooms).where(eq(chatRooms.id, room.id));
    }
    await db.delete(examAttempts).where(eq(examAttempts.jobId, job.id));
    await db.delete(jobExams).where(eq(jobExams.jobId, job.id));
    await db.delete(jobApplications).where(eq(jobApplications.jobId, job.id));
    await db.delete(candidateProfiles).where(eq(candidateProfiles.userId, candidateId));
    await db.delete(jobPostings).where(eq(jobPostings.id, job.id));
    await db.delete(users).where(inArray(users.id, [ownerId, candidateId]));
    console.log("Done — DB restored.");
  } else {
    console.log(`\n--keep: left job=${job.id}, room=${room?.id ?? "n/a"}, users=[${ownerId}, ${candidateId}] in the DB.`);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  console.log(fail === 0 ? "🎉 The core loop runs end-to-end." : "⚠️  The loop broke — see ❌ above.");
}

main()
  .then(async () => { await client.end(); process.exit(fail === 0 ? 0 : 1); })
  .catch(async (err) => { console.error("\n💥 Script error:", err); try { await client.end(); } catch {} process.exit(2); });
