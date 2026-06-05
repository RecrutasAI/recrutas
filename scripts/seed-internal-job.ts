/**
 * Seed ONE real internal job into prod so the core match→exam→chat loop has live
 * supply. Reproduces the exact path POST /api/jobs uses (routes.ts): createJobPosting
 * → generateExamQuestions → createJobExam → match candidates (findMatchingCandidates
 * + createJobMatch + notification).
 *
 * Owner: rainierit@proton.me (talent_owner the user manages — NOT a third party).
 * The role is tailored to the user's real candidate profile (abaskabato@gmail.com,
 * Senior IT Support / Systems Engineer) so it actually surfaces as a match.
 *
 * ⚠️  Writes to the PRODUCTION database.
 *   npx tsx scripts/seed-internal-job.ts           # create the seed job (active)
 *   npx tsx scripts/seed-internal-job.ts --paused  # create it paused (not surfaced)
 *   npx tsx scripts/seed-internal-job.ts --delete   # remove the seed job (cascade)
 */

import { db, client } from "../server/db.js";
import { sql } from "drizzle-orm/sql";
import { storage } from "../server/storage.js";
import { notificationService } from "../server/notification-service.js";
import { callAI, isAIAvailable } from "../server/lib/ai-client.js";

const OWNER_ID = "854622b0-c0ac-4566-a287-3d457c46a810"; // rainierit@proton.me
const CANDIDATE_ID = "94592c0d-223a-4f08-9889-36b67ef783b7"; // abaskabato@gmail.com
const SEED_TAG = "[SEED:core-loop]"; // marker in description for easy identification

const MODE_DELETE = process.argv.includes("--delete");
const MODE_PAUSED = process.argv.includes("--paused");

const q = async (s: string) => { const r: any = await db.execute(sql.raw(s)); return Array.isArray(r) ? r : (r.rows ?? []); };

// Faithful copy of routes.ts generateExamQuestions (it is not exported).
async function generateExamQuestions(job: any) {
  const skills = job.skills || [];
  const requirements = job.requirements || [];
  if (isAIAvailable()) {
    try {
      const systemPrompt = `You are an expert technical recruiter creating a screening exam for job candidates.
Generate exactly 5 questions that test real competence for the role — not self-assessments.

Rules:
- 3 multiple-choice questions (4 options each, one correct answer)
- 2 short-answer questions (practical scenarios)
- Questions must be specific to the job, not generic
- Multiple-choice questions should test knowledge, not experience level
- Short-answer questions should present a realistic work scenario
- Each question is worth 20 points (100 total)
- correctAnswer for multiple-choice is the 0-based index of the correct option

Return JSON: { "questions": [ { "id": "q1"..."q5", "question": string, "type": "multiple-choice"|"short-answer", "options": string[] (only for multiple-choice), "correctAnswer": number (only for multiple-choice), "points": 20 } ] }`;
      const userPrompt = `Job Title: ${job.title}
Company: ${job.company || 'Unknown'}
Description: ${(job.description || '').slice(0, 2000)}
Skills: ${skills.join(', ') || 'Not specified'}
Requirements: ${(requirements || []).join('; ') || 'Not specified'}`;
      const raw = await callAI(systemPrompt, userPrompt, { priority: 'high', estimatedTokens: 1500, temperature: 0.3, maxOutputTokens: 2000 });
      const parsed = JSON.parse(raw);
      const questions = parsed.questions || parsed;
      if (Array.isArray(questions) && questions.length >= 3) {
        return questions.slice(0, 5).map((qq: any, i: number) => ({
          id: qq.id || `q${i + 1}`,
          question: qq.question,
          type: qq.type === 'multiple-choice' ? 'multiple-choice' : 'short-answer',
          ...(qq.type === 'multiple-choice' ? { options: qq.options, correctAnswer: qq.correctAnswer } : {}),
          points: 20,
        }));
      }
    } catch (err) {
      console.warn('[ExamGen] AI generation failed, using fallback:', (err as Error).message);
    }
  }
  const questions: any[] = [];
  for (let i = 0; i < Math.min(skills.length, 3); i++) {
    questions.push({ id: `skill_${i + 1}`, question: `What is your experience level with ${skills[i]}?`, type: 'multiple-choice', options: ['Beginner (0-1 years)', 'Intermediate (2-3 years)', 'Advanced (4-5 years)', 'Expert (5+ years)'], correctAnswer: 1, points: 20 });
  }
  for (let i = 0; i < Math.min(requirements.length, Math.max(1, 3 - questions.length)); i++) {
    questions.push({ id: `req_${i + 1}`, question: `How would you approach: ${requirements[i]}?`, type: 'short-answer', points: 20 });
  }
  if (questions.length < 5) {
    questions.push({ id: 'general_1', question: `Why are you interested in the ${job.title} position and what makes you a strong fit?`, type: 'short-answer', points: 20 });
  }
  return questions;
}

async function deleteSeed() {
  const jobs = await q(`SELECT id, title FROM job_postings WHERE talent_owner_id = '${OWNER_ID}' AND description LIKE '%${SEED_TAG}%'`);
  if (jobs.length === 0) { console.log("No seed job found to delete."); return; }
  for (const j of jobs) {
    await q(`DELETE FROM job_postings WHERE id = ${j.id}`); // FK cascade now handles exams/matches/applications/notifications
    console.log(`Deleted seed job ${j.id} (${j.title}) — cascade cleared exams/matches/applications.`);
  }
}

async function createSeed() {
  const existing = await q(`SELECT id FROM job_postings WHERE talent_owner_id = '${OWNER_ID}' AND description LIKE '%${SEED_TAG}%'`);
  if (existing.length > 0) {
    console.log(`Seed job already exists (id=${existing[0].id}). Run with --delete first to reseed.`);
    return;
  }

  console.log("STEP 1 — create internal job (storage.createJobPosting)");
  const job = await storage.createJobPosting({
    talentOwnerId: OWNER_ID,
    title: "Senior IT Support Engineer",
    company: "Sister",
    description: `${SEED_TAG} We're hiring a Senior IT Support Engineer to own Tier 2/3 support for our distributed team. You'll administer Microsoft 365 and Active Directory, automate device and account workflows with PowerShell, manage endpoints via SCCM/Intune, triage tickets in ServiceNow, and support a mixed Windows/macOS/Linux fleet. You'll be the escalation point for networking and identity issues and help mature our IT runbooks.`,
    requirements: [
      "5+ years in IT support / systems engineering, including Tier 3 escalations",
      "Hands-on Microsoft 365 and Active Directory administration",
      "PowerShell scripting for automation",
      "Endpoint management with SCCM or Intune",
      "ServiceNow (or similar ITSM) ticket workflow ownership",
    ],
    skills: ["ServiceNow", "PowerShell", "Active Directory", "Microsoft 365", "Windows", "Networking", "SCCM", "Linux"],
    location: "Seattle, WA (Hybrid)",
    workType: "hybrid",
    industry: "Technology",
    salaryMin: 95000,
    salaryMax: 130000,
    status: MODE_PAUSED ? "paused" : "active",
    hasExam: true,
    examPassingScore: 70,
    autoRankCandidates: true,
    maxChatCandidates: 5,
    source: "platform", // internal: no externalUrl
  } as any);
  console.log(`  ✅ job created id=${job.id} status=${MODE_PAUSED ? "paused" : "active"}`);

  console.log("STEP 2 — generate exam (generateExamQuestions → storage.createJobExam)");
  const questions = await generateExamQuestions(job);
  await storage.createJobExam({ jobId: job.id, title: `${job.title} Assessment`, passingScore: 70, questions } as any);
  const mc = questions.filter((x: any) => x.type === "multiple-choice").length;
  console.log(`  ✅ exam created — ${questions.length} questions (${mc} multiple-choice, ${questions.length - mc} short-answer)`);

  console.log("STEP 3 — match candidates (storage.findMatchingCandidates → createJobMatch)");
  const candidates = await storage.findMatchingCandidates(job.id);
  let abasMatched = false;
  for (const candidate of candidates) {
    await storage.createJobMatch({ jobId: job.id, ...candidate } as any);
    await notificationService.createNotification({
      userId: candidate.candidateId,
      type: "new_match",
      title: "New Job Match",
      message: `You have a new match for the position of ${job.title}`,
      data: { jobId: job.id },
    }).catch(() => {});
    if (candidate.candidateId === CANDIDATE_ID) abasMatched = true;
  }
  console.log(`  ✅ matched ${candidates.length} candidates`);
  console.log(`  ${abasMatched ? "✅" : "⚠️ "} abaskabato@gmail.com ${abasMatched ? "received a match — visible in their feed" : "did NOT match (check skills/embedding threshold)"}`);

  console.log(`\nSeed complete. Job id=${job.id}. Log in as abaskabato@gmail.com to apply → take exam → chat.`);
  console.log(`Clean up later with: npx tsx scripts/seed-internal-job.ts --delete`);
}

async function main() {
  if (MODE_DELETE) await deleteSeed();
  else await createSeed();
  await client.end();
}
main().then(() => process.exit(0)).catch(async e => { console.error("Seed error:", e); try { await client.end(); } catch {} process.exit(1); });
