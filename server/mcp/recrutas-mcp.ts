/**
 * Recrutas as an MCP server: a candidate's matches, verdicts and applications,
 * inside the AI tools they already use (Claude Code, Claude Desktop, Cursor…).
 *
 * One server per request (stateless Streamable HTTP, see the /api/mcp route),
 * bound to the user whose personal access token authenticated the request.
 * Every tool reuses the code behind the web app, so answers match the
 * dashboard exactly. Applying stays a human step: `get_job` returns the
 * posting's link, where the Recrutas extension fills the form and the person
 * clicks submit. Nothing is ever submitted on anyone's behalf.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sql } from 'drizzle-orm/sql';
import { db } from '../db';
import { storage } from '../storage';
import { diagnoseCandidate } from '../services/application-diagnosis.service';
import { buildWeeklySummary, weeklySummaryText } from '../services/weekly-summary.service';
import {
  extractHardRequirements, verdictFor, yearsFromPositions, descriptionToText,
  type CandidateFacts, type HardRequirements,
} from '../lib/hard-requirements';

const rows = (r: any): any[] => (r?.rows ?? r) as any[];
const PAGE_SIZE = 20;
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const daysAgo = (d?: string | Date | null) => (d ? Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 864e5)) : null);

async function candidateFacts(userId: string): Promise<CandidateFacts> {
  const p = rows(await db.execute(sql`
    SELECT job_preferences->'applicationAnswers' AS answers, resume_parsing_data->'positions' AS positions
    FROM candidate_users WHERE user_id = ${userId}::uuid`))[0] ?? {};
  const a = p.answers || {};
  return {
    usCitizen: a.usCitizen, needsSponsorship: a.needsSponsorship, workAuthorizedUS: a.workAuthorizedUS,
    securityClearance: a.securityClearance, years: yearsFromPositions(p.positions),
  };
}

function requirementLines(r: HardRequirements): string[] {
  const out: string[] = [];
  const names: Record<string, string> = { public_trust: 'Public Trust', secret: 'Secret', top_secret: 'Top Secret', ts_sci: 'TS/SCI' };
  if (r.clearance) {out.push(`Active ${names[r.clearance]} clearance`);}
  if (r.clearanceObtainable) {out.push('Able to obtain a security clearance');}
  if (r.usCitizen) {out.push('US citizenship');}
  if (r.usPerson) {out.push('US person (citizen or permanent resident)');}
  if (r.noSponsorship) {out.push('No visa sponsorship');}
  if (r.minYears != null) {out.push(`${r.minYears}+ years of experience`);}
  return out;
}

export const MCP_INSTRUCTIONS = `Recrutas finds live jobs taken directly from company career pages, matches them to the user's resume, and tracks what happens after they apply.
Typical flow: search_my_matches (optionally verdict "apply") → get_job for details and the apply link → the user applies on the company's site (the Recrutas browser extension fills the form; the user submits) → record_application if the extension didn't log it → my_week, list_my_applications or why_no_replies later.
Verdicts: "apply" = meets stated requirements; "stretch" = a gap; "skip" = a stated requirement the user said they don't meet. "Check" items are requirements the user hasn't answered in Recrutas Settings → Application answers. Never apply or submit anything on the user's behalf.`;

export function buildRecrutasMcpServer(userId: string): McpServer {
  const server = new McpServer({ name: 'recrutas', version: '1.0.0' }, { instructions: MCP_INSTRUCTIONS });

  server.registerTool('search_my_matches', {
    title: 'Search my job matches',
    description: "The user's ranked job matches (up to 100 live jobs from company career pages), each with a match score and an honest verdict: apply, stretch or skip, with the reason. Filter by verdict, how recently posted, location or work type. 20 per page.",
    inputSchema: {
      verdict: z.enum(['apply', 'stretch', 'skip']).optional().describe('Only matches with this verdict'),
      posted_within_days: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(14), z.literal(30)]).optional().describe('Only jobs posted within this many days'),
      location: z.string().max(80).optional().describe('City or location substring, e.g. "Seattle"'),
      work_type: z.enum(['remote', 'hybrid', 'onsite']).optional(),
      page: z.number().int().min(1).max(5).optional().describe('Page of 20 (default 1)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ verdict, posted_within_days, location, work_type, page = 1 }) => {
    const feed = await storage.getJobRecommendations(userId,
      { postedWithinDays: posted_within_days, location, workType: work_type } as any, { page: 1, limit: 100 });
    let jobs = (feed.jobs || []) as any[];
    if (verdict) {jobs = jobs.filter(j => j.verdict?.label === verdict);}
    const slice = jobs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    if (!slice.length) {
      return text(jobs.length ? `No more matches on page ${page}.` : 'No matches with these filters. If the user has no resume on Recrutas yet, they need to upload one at https://www.recrutas.ai.');
    }
    const lines = slice.map(j => {
      const v = j.verdict;
      const posted = daysAgo(j.createdAt);
      return [
        `#${j.id} ${String(j.title).trim()} · ${j.company} · ${j.location || 'location n/a'}${j.workType ? ` (${j.workType})` : ''}`,
        `  match ${j.matchScore}%${v ? ` · ${v.label.toUpperCase()}: ${v.reasons[0]}` : ''}${posted != null ? ` · posted ${posted}d ago` : ''}`,
        ...(v?.toCheck?.length ? [`  check: ${v.toCheck.join('; ')}`] : []),
      ].join('\n');
    });
    return text(`${jobs.length} matches${verdict ? ` with verdict "${verdict}"` : ''}; page ${page} of ${Math.max(1, Math.ceil(jobs.length / PAGE_SIZE))}.\n\n${lines.join('\n')}`);
  });

  server.registerTool('get_job', {
    title: 'Get job details',
    description: "Details for one job by id (from search_my_matches): what the posting requires, the user's verdict for it, whether it's still live on the company's board, a description excerpt, and the link to apply on the company's site.",
    inputSchema: { job_id: z.number().int().positive() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ job_id }) => {
    const job: any = await storage.getJobPosting(job_id);
    if (!job || job.status === 'paused') {return text(`No job #${job_id}.`);}
    const req = extractHardRequirements(job.description);
    const v = verdictFor(req, await candidateFacts(userId), 70);
    const applied = rows(await db.execute(sql`SELECT applied_at FROM job_applications WHERE job_id = ${job_id} AND candidate_id = ${userId}::uuid LIMIT 1`))[0];
    const live = job.status === 'active' ? 'still posted on the company\'s careers page' : job.livenessStatus === 'removed' ? 'taken down by the company' : 'closed';
    const reqs = requirementLines(req);
    const desc = descriptionToText(job.description || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1800);
    return text([
      `#${job.id} ${String(job.title).trim()} at ${job.company}`,
      `Location: ${job.location || 'n/a'}${job.workType ? ` (${job.workType})` : ''} · Status: ${live}`,
      `Verdict: ${v.label.toUpperCase()}: ${v.reasons[0]}${v.toCheck.length ? `\nCheck (not yet answered in Settings): ${v.toCheck.join('; ')}` : ''}`,
      `Stated requirements: ${reqs.length ? reqs.join('; ') : 'none of the hard requirements we check (clearance, citizenship, sponsorship, years)'}`,
      applied ? `Already applied on ${new Date(applied.applied_at).toDateString()}.` : `Apply: ${job.externalUrl || 'https://www.recrutas.ai/candidate-dashboard'} (the Recrutas extension fills the form; the user submits it).`,
      '',
      desc,
    ].join('\n'));
  });

  server.registerTool('list_my_applications', {
    title: 'List my applications',
    description: "Jobs the user applied to and what happened since: still posted, taken down by the company (most likely filled), or reposted (they may still be looking), plus any status updates.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const apps = await storage.getApplicationsWithStatus(userId);
    if (!apps.length) {return text('No applications tracked yet.');}
    const lines = apps.slice(0, 50).map((a: any) => {
      const state = a.reposted ? 'reposted by the company' : a.job?.postingState === 'taken_down' ? 'taken down by the company' : a.job?.postingState === 'live' ? 'still posted' : 'posting status unknown';
      return `#${a.jobId} ${String(a.job?.title || '').trim()} · ${a.job?.company} · applied ${daysAgo(a.appliedAt)}d ago · ${a.status} · ${state}`;
    });
    return text(`${apps.length} application${apps.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
  });

  server.registerTool('record_application', {
    title: 'Record that I applied',
    description: "Record that the user applied to a job (by id), when the Recrutas extension didn't log it automatically. Only call this after the user confirms they submitted the application. Idempotent.",
    inputSchema: { job_id: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => {
    const job: any = await storage.getJobPosting(job_id);
    if (!job) {return text(`No job #${job_id}.`);}
    const r = rows(await db.execute(sql`
      INSERT INTO job_applications (candidate_id, job_id, status, metadata)
      VALUES (${userId}::uuid, ${job_id}, 'submitted', ${JSON.stringify({ source: 'mcp' })}::jsonb)
      ON CONFLICT (job_id, candidate_id) DO NOTHING RETURNING id`));
    return text(r.length
      ? `Recorded: applied to ${String(job.title).trim()} at ${job.company}. Recrutas will say if the posting is taken down or reposted.`
      : `Already recorded: ${String(job.title).trim()} at ${job.company}.`);
  });

  server.registerTool('why_no_replies', {
    title: "Why am I not hearing back?",
    description: "A diagnosis of the user's own applications: replies, take-downs and reposts, whether they applied after postings usually come down, how many were a stretch on stated requirements, and one next step.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const d = await diagnoseCandidate(userId);
    return text([...d.findings.map(f => `- ${f}`), '', `${d.enoughData ? 'Next step: ' : ''}${d.nextStep.text}`].join('\n').trim());
  });

  server.registerTool('my_week', {
    title: 'My week',
    description: "The user's job search this week: what they applied to, what happened (taken down, reposted, employer responded), how many are still waiting, new jobs they qualify for, and one next step.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => text(weeklySummaryText(await buildWeeklySummary(userId))));

  return server;
}
