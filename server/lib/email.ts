/**
 * Email utility using Resend.
 * No-op when RESEND_API_KEY is not set (dev/test environments).
 */

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  /** Extra headers, e.g. List-Unsubscribe (see lib/unsubscribe.ts). */
  headers?: Record<string, string>;
}

export interface MatchedJob {
  jobId: number;
  title: string;
  company: string;
  location?: string | null;
  workType?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  matchScore: number;
  skillMatches: string[];
}

const FROM = 'Recrutas <hello@recrutas.ai>';
const REPLY_TO = 'support@recrutas.ai';

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[Email] RESEND_API_KEY not set — skipping email to', opts.to);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      reply_to: REPLY_TO,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      ...(opts.headers ? { headers: opts.headers } : {}),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err.slice(0, 200)}`);
  }
}

// ── Email templates ───────────────────────────────────────────────────────────

function workTypeLabel(w?: string | null): string {
  if (w === 'remote') return 'Remote';
  if (w === 'hybrid') return 'Hybrid';
  if (w === 'onsite') return 'On-site';
  return '';
}

function salaryLabel(min?: number | null, max?: number | null): string {
  if (!min && !max) return '';
  const fmt = (n: number) => n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;
  if (min && max) return `${fmt(min)} – ${fmt(max)}`;
  if (min) return `${fmt(min)}+`;
  return `Up to ${fmt(max!)}`;
}

function scoreColor(score: number): string {
  if (score >= 85) return '#059669';
  if (score >= 70) return '#0891b2';
  return '#d97706';
}

function scoreLabel(score: number): string {
  if (score >= 85) return 'Excellent match';
  if (score >= 70) return 'Strong match';
  return 'Good match';
}

export function matchesReadyEmail(candidateName: string, matchCount: number, jobs: MatchedJob[] = []): string {
  const firstName = candidateName ? candidateName.split(' ')[0] : null;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

  const jobCards = jobs.slice(0, 5).map(job => {
    const meta: string[] = [];
    if (job.location) meta.push(job.location);
    if (job.workType) meta.push(workTypeLabel(job.workType));
    const salary = salaryLabel(job.salaryMin, job.salaryMax);
    if (salary) meta.push(salary);

    const topSkills = (job.skillMatches || []).slice(0, 4);

    return `
    <div style="border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px 24px; margin-bottom: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
        <div>
          <p style="margin: 0; font-size: 16px; font-weight: 700; color: #111827;">${job.title}</p>
          <p style="margin: 4px 0 0; font-size: 14px; color: #6b7280;">${job.company}${meta.length ? ' · ' + meta.join(' · ') : ''}</p>
        </div>
        <div style="text-align: right; flex-shrink: 0; margin-left: 16px;">
          <span style="display: inline-block; background: ${scoreColor(job.matchScore)}20; color: ${scoreColor(job.matchScore)}; font-size: 13px; font-weight: 700; padding: 4px 10px; border-radius: 20px; white-space: nowrap;">
            ${job.matchScore}% · ${scoreLabel(job.matchScore)}
          </span>
        </div>
      </div>
      ${topSkills.length ? `
      <div style="margin-top: 10px;">
        ${topSkills.map(s => `<span style="display: inline-block; background: #f0fdf4; color: #065f46; font-size: 12px; font-weight: 500; padding: 3px 8px; border-radius: 4px; margin: 2px 4px 2px 0;">${s}</span>`).join('')}
      </div>` : ''}
    </div>`;
  }).join('');

  const hasMore = matchCount > 5;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your job matches are ready</title>
</head>
<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">

  <div style="max-width: 600px; margin: 32px auto; padding: 0 16px;">

    <!-- Header -->
    <div style="background: #059669; border-radius: 12px 12px 0 0; padding: 28px 40px; text-align: center;">
      <p style="margin: 0; font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">Recrutas</p>
      <p style="margin: 6px 0 0; font-size: 13px; color: #a7f3d0; letter-spacing: 0.5px; text-transform: uppercase;">Job Search, ReInvented.</p>
    </div>

    <!-- Body -->
    <div style="background: #ffffff; border-radius: 0 0 12px 12px; padding: 36px 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.06);">

      <p style="margin: 0 0 6px; font-size: 22px; font-weight: 700; color: #111827;">${greeting}</p>
      <p style="margin: 0 0 28px; font-size: 15px; color: #4b5563; line-height: 1.6;">
        We analyzed your resume and found <strong style="color: #059669;">${matchCount} job${matchCount !== 1 ? 's' : ''}</strong> matched to your skills and experience.
        ${jobs.length > 0 ? `Here are your top picks:` : ''}
      </p>

      ${jobCards}

      ${hasMore ? `<p style="margin: 4px 0 28px; font-size: 14px; color: #6b7280; text-align: center;">+ ${matchCount - 5} more match${matchCount - 5 !== 1 ? 'es' : ''} waiting for you</p>` : '<div style="margin-bottom: 28px;"></div>'}

      <div style="text-align: center;">
        <a href="https://www.recrutas.ai/candidate-dashboard"
           style="display: inline-block; background: #059669; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 8px; font-weight: 700; font-size: 15px; letter-spacing: 0.2px;">
          View All My Matches →
        </a>
      </div>

      <!-- Trust bar -->
      <div style="margin: 32px 0 0; padding: 18px 20px; background: #f0fdf4; border-radius: 8px; border-left: 4px solid #059669;">
        <p style="margin: 0; font-size: 14px; font-weight: 700; color: #065f46;">24-hour response guarantee</p>
        <p style="margin: 6px 0 0; font-size: 13px; color: #047857; line-height: 1.5;">
          Every internal job on Recrutas comes with a guaranteed employer response within 24 hours. If they don't respond, the application is automatically closed and you move on. No black holes.
        </p>
      </div>

    </div>

    <!-- Footer -->
    <p style="margin: 20px 0 40px; text-align: center; font-size: 12px; color: #9ca3af;">
      You're receiving this because you uploaded a resume to Recrutas. ·
      <a href="https://www.recrutas.ai" style="color: #6b7280;">recrutas.ai</a>
    </p>

  </div>
</body>
</html>
  `.trim();
}

// ── Shared base layout ────────────────────────────────────────────────────────

// Physical postal address required in commercial email (CAN-SPAM). Set
// EMAIL_POSTAL_ADDRESS on the VPS and Vercel; until then it is omitted.
const postalAddress = (): string => (process.env.EMAIL_POSTAL_ADDRESS || '').trim();

function emailBase(body: string, footerNote = "You're receiving this as a Recrutas user.", unsubscribeUrl?: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:600px;margin:32px auto;padding:0 16px;">

  <!-- Header -->
  <div style="background:#059669;border-radius:12px 12px 0 0;padding:28px 40px;text-align:center;">
    <p style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">Recrutas</p>
    <p style="margin:6px 0 0;font-size:13px;color:#a7f3d0;letter-spacing:0.5px;text-transform:uppercase;">Job Search, ReInvented.</p>
  </div>

  <!-- Body -->
  <div style="background:#ffffff;border-radius:0 0 12px 12px;padding:36px 40px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
    ${body}
  </div>

  <!-- Footer -->
  <p style="margin:20px 0 40px;text-align:center;font-size:12px;color:#9ca3af;">
    ${footerNote} · <a href="https://www.recrutas.ai" style="color:#6b7280;">recrutas.ai</a>${unsubscribeUrl ? ` · <a href="${unsubscribeUrl}" style="color:#6b7280;">Unsubscribe</a>` : ''}${postalAddress() ? `<br/>Recrutas · ${escapeHtml(postalAddress())}` : ''}
  </p>

</div>
</body>
</html>`.trim();
}

// ── Employer welcome ──────────────────────────────────────────────────────────

export function employerWelcomeEmail(firstName?: string): string {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      Welcome to Recrutas. You're now set up to post jobs and find pre-screened candidates, fast.
    </p>

    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;margin-bottom:12px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#111827;">Post a job in minutes</p>
      <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">Add a role, optionally attach a screening exam, and start receiving ranked, pre-screened candidates.</p>
    </div>
    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;margin-bottom:12px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#111827;">AI-ranked applicants</p>
      <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">Candidates are matched and ranked by skill fit before they reach your inbox. No resume pile.</p>
    </div>
    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#111827;">The 24-hour rule</p>
      <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">Candidates who pass your exam expect a response within 24 hours. That's the Recrutas promise. It's what makes candidates trust the platform and apply seriously.</p>
    </div>

    <div style="text-align:center;">
      <a href="https://www.recrutas.ai/talent-dashboard"
         style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        Post Your First Job →
      </a>
    </div>
  `, "You're receiving this because you created an employer account on Recrutas.");
}

// ── Employer: new applicant ───────────────────────────────────────────────────

export function employerNewApplicantEmail(
  employerFirstName: string | undefined,
  candidateName: string,
  jobTitle: string,
  hasExam: boolean,
  applicationId: number,
): string {
  const greeting = employerFirstName ? `Hi ${employerFirstName},` : 'Hi,';
  const examNote = hasExam
    ? `<p style="margin:8px 0 0;font-size:14px;color:#047857;">They'll need to pass your screening exam before advancing.</p>`
    : '';
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      You have a new applicant for <strong>${jobTitle}</strong>.
    </p>

    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0;font-size:16px;font-weight:700;color:#111827;">${candidateName}</p>
      <p style="margin:4px 0 0;font-size:14px;color:#6b7280;">Applied to <strong>${jobTitle}</strong></p>
      ${examNote}
    </div>

    <div style="text-align:center;margin-bottom:28px;">
      <a href="https://www.recrutas.ai/talent-dashboard"
         style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        Review Application →
      </a>
    </div>

    <div style="padding:18px 20px;background:#fef3c7;border-radius:8px;border-left:4px solid #d97706;">
      <p style="margin:0;font-size:14px;font-weight:700;color:#92400e;">Remember: 24-hour response window</p>
      <p style="margin:6px 0 0;font-size:13px;color:#b45309;line-height:1.5;">
        Once a candidate passes your screening exam, you have 24 hours to respond. After that, the application is automatically closed and the candidate moves on.
      </p>
    </div>
  `, "You're receiving this because you have an active job posting on Recrutas.");
}

// ── Employer: SLA warning ─────────────────────────────────────────────────────

export function employerSLAWarningEmail(
  employerFirstName: string | undefined,
  candidateName: string,
  jobTitle: string,
  hoursLeft: number,
): string {
  const greeting = employerFirstName ? `Hi ${employerFirstName},` : 'Hi,';
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      You have <strong style="color:#dc2626;">${hoursLeft} hours</strong> left to respond to a candidate who passed your screening exam.
    </p>

    <div style="border:1px solid #fca5a5;border-radius:10px;padding:20px 24px;margin-bottom:28px;background:#fff5f5;">
      <p style="margin:0;font-size:16px;font-weight:700;color:#111827;">${candidateName}</p>
      <p style="margin:4px 0 0;font-size:14px;color:#6b7280;">Passed exam for <strong>${jobTitle}</strong></p>
      <p style="margin:8px 0 0;font-size:14px;font-weight:600;color:#dc2626;">Expires in ${hoursLeft} hours</p>
    </div>

    <div style="text-align:center;margin-bottom:28px;">
      <a href="https://www.recrutas.ai/talent-dashboard"
         style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        Respond Now →
      </a>
    </div>

    <div style="padding:18px 20px;background:#f3f4f6;border-radius:8px;">
      <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;">
        If you don't respond in time, the application will be automatically closed and the candidate will be notified. This is the Recrutas guarantee to candidates. It's what drives serious applicants to the platform.
      </p>
    </div>
  `, "You're receiving this because you have an active job posting on Recrutas.");
}

// ── Candidate: exam pass ──────────────────────────────────────────────────────

export function candidateExamPassEmail(
  candidateName: string | undefined,
  jobTitle: string,
  company: string,
  score: number,
  ranking: number,
  totalCandidates: number,
): string {
  const firstName = candidateName?.split(' ')[0];
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const rankLabel = ranking === 1 ? '🥇 #1 ranked candidate' : `#${ranking} of ${totalCandidates} candidates`;
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      You passed the screening exam for <strong>${jobTitle}</strong> at <strong>${company}</strong>. Chat is now unlocked.
    </p>

    <div style="border:1px solid #bbf7d0;border-radius:10px;padding:20px 24px;margin-bottom:12px;background:#f0fdf4;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <p style="margin:0;font-size:16px;font-weight:700;color:#111827;">${jobTitle}</p>
          <p style="margin:4px 0 0;font-size:14px;color:#6b7280;">${company}</p>
        </div>
        <span style="background:#059669;color:#ffffff;font-size:13px;font-weight:700;padding:4px 12px;border-radius:20px;">${score}% ✓</span>
      </div>
      <p style="margin:12px 0 0;font-size:13px;color:#065f46;font-weight:600;">${rankLabel}</p>
    </div>

    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#111827;">What happens next</p>
      <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;">
        The employer has <strong>24 hours</strong> to reach out to you. That's the Recrutas guarantee: no ghosting. If they don't respond in time, the application closes automatically and you're free to move on.
      </p>
    </div>

    <div style="text-align:center;">
      <a href="https://www.recrutas.ai/candidate-dashboard"
         style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        Go to Dashboard →
      </a>
    </div>
  `);
}

// ── Subscription confirmed ────────────────────────────────────────────────────

export function subscriptionConfirmedEmail(
  firstName: string | undefined,
  planName: string,
  billingCycle: 'monthly' | 'yearly',
  pricePerMonth: string,
): string {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const cycleLabel = billingCycle === 'yearly' ? 'annually' : 'monthly';
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      Your <strong>${planName}</strong> plan is now active. Welcome to the full Recrutas experience.
    </p>

    <div style="background:#f0fdf4;border-left:4px solid #059669;border-radius:8px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#065f46;">Plan confirmed</p>
      <p style="margin:4px 0 0;font-size:14px;color:#047857;line-height:1.5;">
        <strong>${planName}</strong> · ${pricePerMonth}/mo · billed ${cycleLabel}
      </p>
    </div>

    <div style="text-align:center;margin-bottom:28px;">
      <a href="https://www.recrutas.ai/talent-dashboard"
         style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        Go to Dashboard →
      </a>
    </div>

    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;">
      <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#111827;">Manage your subscription</p>
      <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">
        You can update or cancel your plan at any time from your account settings.
      </p>
    </div>
  `, "You're receiving this because you upgraded on Recrutas.");
}

// ── Payment failed ────────────────────────────────────────────────────────────

export function paymentFailedEmail(firstName: string | undefined): string {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      We were unable to process your recent payment for your Recrutas subscription.
    </p>

    <div style="background:#fef3c7;border-left:4px solid #d97706;border-radius:8px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#92400e;">Action required</p>
      <p style="margin:6px 0 0;font-size:13px;color:#b45309;line-height:1.5;">
        Please update your payment method to keep your account active. Your access will remain available while we retry, but may be suspended if payment continues to fail.
      </p>
    </div>

    <div style="text-align:center;margin-bottom:28px;">
      <a href="https://www.recrutas.ai/talent-dashboard"
         style="display:inline-block;background:#d97706;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        Update Payment Method →
      </a>
    </div>

    <p style="margin:0;font-size:13px;color:#9ca3af;text-align:center;">
      If you believe this is an error, reply to this email and we'll help you right away.
    </p>
  `, "You're receiving this because you have an active subscription on Recrutas.");
}

// ── Subscription canceled ─────────────────────────────────────────────────────

export function subscriptionCanceledEmail(
  firstName: string | undefined,
  planName: string,
  periodEnd: string,
): string {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      Your <strong>${planName}</strong> subscription has been canceled.
    </p>

    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#111827;">Access ends ${periodEnd}</p>
      <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5;">
        You'll continue to have full access until <strong>${periodEnd}</strong>. After that, your account will revert to the free plan.
      </p>
    </div>

    <div style="text-align:center;margin-bottom:28px;">
      <a href="https://www.recrutas.ai/talent-dashboard"
         style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        Reactivate Plan →
      </a>
    </div>

    <p style="margin:0;font-size:13px;color:#9ca3af;text-align:center;">
      Changed your mind? You can reactivate anytime before ${periodEnd}.
    </p>
  `, "You're receiving this because you canceled your Recrutas subscription.");
}

// ── Application submitted (candidate) ─────────────────────────────────────────

export function applicationSubmittedEmail(
  candidateName: string | undefined,
  jobTitle: string,
  company: string,
  hasExam: boolean,
): string {
  const firstName = candidateName?.split(' ')[0];
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const examNote = hasExam
    ? `<div style="background:#f0fdf4;border-left:4px solid #059669;border-radius:8px;padding:16px 20px;margin-bottom:28px;">
        <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#065f46;">Next step: screening exam</p>
        <p style="margin:0;font-size:13px;color:#047857;line-height:1.5;">This role includes a short screening exam. Complete it to advance your application and stand out to the employer.</p>
      </div>`
    : `<div style="background:#f0fdf4;border-left:4px solid #059669;border-radius:8px;padding:16px 20px;margin-bottom:28px;">
        <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#065f46;">24-hour response guarantee</p>
        <p style="margin:0;font-size:13px;color:#047857;line-height:1.5;">The employer has 24 hours to respond. No ghosting, ever.</p>
      </div>`;
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      Your application was received. Here's a summary:
    </p>

    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;margin-bottom:12px;">
      <p style="margin:0;font-size:16px;font-weight:700;color:#111827;">${jobTitle}</p>
      <p style="margin:4px 0 0;font-size:14px;color:#6b7280;">${company}</p>
    </div>

    ${examNote}

    <div style="text-align:center;">
      <a href="https://www.recrutas.ai/candidate-dashboard"
         style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        Track My Application →
      </a>
    </div>
  `);
}

// ── Chat unlocked (candidate) ─────────────────────────────────────────────────

export function chatUnlockedEmail(
  candidateName: string | undefined,
  jobTitle: string,
  company: string,
): string {
  const firstName = candidateName?.split(' ')[0];
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      Great news! <strong>${company}</strong> wants to connect with you about the <strong>${jobTitle}</strong> role. Your chat is now open.
    </p>

    <div style="background:#f0fdf4;border-left:4px solid #059669;border-radius:8px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0;font-size:16px;font-weight:700;color:#065f46;">${jobTitle}</p>
      <p style="margin:4px 0 0;font-size:14px;color:#047857;">${company}</p>
      <p style="margin:10px 0 0;font-size:13px;color:#065f46;">Chat is unlocked. Start the conversation now.</p>
    </div>

    <div style="text-align:center;">
      <a href="https://www.recrutas.ai/candidate-dashboard"
         style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        Open Chat →
      </a>
    </div>
  `);
}

// ── SLA breached — candidate notification ─────────────────────────────────────

export function slaBreachedEmail(
  candidateName: string | undefined,
  jobTitle: string,
  company: string,
): string {
  const firstName = candidateName?.split(' ')[0];
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      <strong>${company}</strong> did not respond to your <strong>${jobTitle}</strong> application within 24 hours. Per the Recrutas guarantee, your application has been automatically closed.
    </p>

    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#111827;">What this means for you</p>
      <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;">
        You are free to move on. This is not a reflection of your candidacy. The employer simply failed to meet their 24-hour commitment. Your profile and matches remain fully active.
      </p>
    </div>

    <div style="text-align:center;">
      <a href="https://www.recrutas.ai/candidate-dashboard"
         style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        View More Jobs →
      </a>
    </div>
  `);
}

// ── Job posted confirmation (employer) ────────────────────────────────────────

export function jobPostedEmail(
  employerFirstName: string | undefined,
  jobTitle: string,
  hasExam: boolean,
  jobId: number,
): string {
  const greeting = employerFirstName ? `Hi ${employerFirstName},` : 'Hi,';
  const examNote = hasExam
    ? `<p style="margin:8px 0 0;font-size:13px;color:#047857;">Includes a screening exam. Candidates must pass before advancing.</p>`
    : `<p style="margin:8px 0 0;font-size:13px;color:#6b7280;">No screening exam. Candidates can apply directly.</p>`;
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      Your job is live and candidates are being matched now.
    </p>

    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;margin-bottom:12px;">
      <p style="margin:0;font-size:16px;font-weight:700;color:#111827;">${jobTitle}</p>
      <p style="margin:4px 0 0;font-size:14px;color:#6b7280;">Job ID: ${jobId}</p>
      ${examNote}
    </div>

    <div style="background:#fef3c7;border-left:4px solid #d97706;border-radius:8px;padding:16px 20px;margin-bottom:28px;">
      <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#92400e;">Remember: 24-hour response window</p>
      <p style="margin:0;font-size:13px;color:#b45309;line-height:1.5;">
        Once a candidate passes your screening, you have 24 hours to respond. We'll alert you before the deadline.
      </p>
    </div>

    <div style="text-align:center;">
      <a href="https://www.recrutas.ai/talent-dashboard"
         style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        Manage Job →
      </a>
    </div>
  `, "You're receiving this because you posted a job on Recrutas.");
}

// ── Renewal reminder ──────────────────────────────────────────────────────────

export function renewalReminderEmail(
  firstName: string | undefined,
  planName: string,
  renewalDate: string,
  price: string,
): string {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      Your <strong>${planName}</strong> plan renews in 3 days. No action needed. We'll charge your card on file automatically.
    </p>

    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0;font-size:16px;font-weight:700;color:#111827;">${planName}</p>
      <p style="margin:4px 0 0;font-size:14px;color:#6b7280;">Renews on <strong>${renewalDate}</strong> · ${price}</p>
    </div>

    <div style="text-align:center;margin-bottom:28px;">
      <a href="https://www.recrutas.ai/talent-dashboard"
         style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        Manage Subscription →
      </a>
    </div>

    <p style="margin:0;font-size:13px;color:#9ca3af;text-align:center;">
      To cancel before renewal, visit your account settings.
    </p>
  `, "You're receiving this as a Recrutas subscriber.");
}

// ── Password reset (branded) ──────────────────────────────────────────────────

export function passwordResetEmail(resetUrl: string): string {
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">Reset your password</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      We received a request to reset your Recrutas password. Click the button below. This link expires in 1 hour.
    </p>

    <div style="text-align:center;margin-bottom:28px;">
      <a href="${resetUrl}"
         style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        Reset Password →
      </a>
    </div>

    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px 20px;">
      <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;">
        If the button doesn't work, paste this link into your browser:<br>
        <a href="${resetUrl}" style="color:#059669;word-break:break-all;">${resetUrl}</a>
      </p>
    </div>

    <p style="margin:20px 0 0;font-size:13px;color:#9ca3af;text-align:center;">
      If you didn't request this, you can safely ignore this email.
    </p>
  `, "You're receiving this because a password reset was requested for your Recrutas account.");
}

// ── Candidate: exam fail ──────────────────────────────────────────────────────

export function candidateExamFailEmail(
  candidateName: string | undefined,
  jobTitle: string,
  company: string,
  score: number,
  passingScore: number,
  aiFeedback?: string,
): string {
  const firstName = candidateName?.split(' ')[0];
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      You scored <strong>${score}%</strong> on the <strong>${jobTitle}</strong> exam at ${company}. The passing score was ${passingScore}%.
    </p>

    ${aiFeedback ? `
    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;margin-bottom:12px;">
      <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#111827;">Feedback</p>
      <p style="margin:0;font-size:14px;color:#4b5563;line-height:1.6;">${aiFeedback}</p>
    </div>
    ` : ''}

    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#111827;">Keep going</p>
      <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;">
        You have ${10 - score > 0 ? `${passingScore - score}% to close` : 'room to grow'}. Every Recrutas employer responds within 24 hours. No ghosting, ever. There are more matches waiting for you.
      </p>
    </div>

    <div style="text-align:center;">
      <a href="https://www.recrutas.ai/candidate-dashboard"
         style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">
        View More Jobs →
      </a>
    </div>
  `);
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** What happened to jobs a candidate applied to: taken down, or reposted. */
export function applicationUpdatesDigestEmail(
  firstName: string | null | undefined,
  items: Array<{ kind: 'closed' | 'reposted'; title: string; message: string }>,
  unsubscribeUrl?: string,
): string {
  const greeting = firstName ? `Hi ${escapeHtml(firstName.split(' ')[0])},` : 'Hi,';
  const cards = items.map(i => `
    <div style="border:1px solid ${i.kind === 'reposted' ? '#bfdbfe' : '#e5e7eb'};border-radius:10px;padding:16px 20px;margin-bottom:12px;background:${i.kind === 'reposted' ? '#eff6ff' : '#ffffff'};">
      <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#111827;">${escapeHtml(i.title)}</p>
      <p style="margin:0;font-size:14px;color:#4b5563;line-height:1.6;">${escapeHtml(i.message)}</p>
    </div>`).join('');
  return emailBase(`
    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
      Here's what changed with ${items.length === 1 ? 'a job' : 'jobs'} you applied to. We check every company's careers page daily so you don't have to wonder.
    </p>
    ${cards}
    <div style="text-align:center;margin:28px 0 8px;">
      <a href="https://www.recrutas.ai/candidate-dashboard"
         style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;">
        See your applications
      </a>
    </div>
  `, "You're receiving this because you applied to these jobs.", unsubscribeUrl);
}

/** The weekly summary: applications, what happened to them, new jobs they qualify for. */
export function weeklySummaryEmail(
  firstName: string | null | undefined,
  s: {
    appliedThisWeek: Array<{ title: string; company: string }>;
    updates: Array<{ kind: 'taken_down' | 'reposted' | 'replied'; title: string; company: string }>;
    waiting: number;
    waitingPastFollowUp: number;
    newApplyMatches: number;
    topMatches: Array<{ title: string; company: string; location: string | null }>;
    nextStep: string | null;
  },
  unsubscribeUrl?: string,
): string {
  const e = escapeHtml;
  const greeting = firstName ? `Hi ${e(firstName.split(' ')[0])},` : 'Hi,';
  const section = (title: string, body: string) => `
    <p style="margin:24px 0 8px;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;">${title}</p>${body}`;
  const list = (items: string[]) => `<ul style="margin:0;padding-left:20px;font-size:15px;color:#111827;line-height:1.7;">${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
  const updateText: Record<string, string> = {
    taken_down: 'was taken down (most likely filled)',
    reposted: 'was taken down and posted again (they may still be looking)',
    replied: 'got a response',
  };
  let body = `<p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">${greeting}</p>
    <p style="margin:0;font-size:15px;color:#4b5563;line-height:1.6;">Here's your week. We check every company's careers page daily, so you don't have to wonder.</p>`;
  if (s.appliedThisWeek.length) {
    body += section(`You applied to ${s.appliedThisWeek.length}`, list(s.appliedThisWeek.map(a => `${e(a.title)} · ${e(a.company)}`)));
  }
  if (s.updates.length) {
    body += section('What happened', list(s.updates.map(u => `${e(u.title)} at ${e(u.company)} ${updateText[u.kind]}`)));
  }
  if (s.waiting) {
    body += section('Still waiting', `<p style="margin:0;font-size:15px;color:#111827;line-height:1.6;">${s.waiting} application${s.waiting === 1 ? '' : 's'} with the job still posted${s.waitingPastFollowUp ? `, ${s.waitingPastFollowUp} of them past two weeks. A short follow-up to the recruiter is worth sending` : ''}.</p>`);
  }
  if (s.newApplyMatches) {
    body += section(`${s.newApplyMatches} new job${s.newApplyMatches === 1 ? '' : 's'} you qualify for`,
      list(s.topMatches.map(m => `${e(m.title)} · ${e(m.company)}${m.location ? ` · ${e(m.location)}` : ''}`)));
  }
  if (s.nextStep) {
    body += `<div style="margin-top:24px;border-radius:10px;padding:14px 18px;background:#eff6ff;font-size:15px;color:#1e3a8a;line-height:1.6;"><strong>Next step:</strong> ${e(s.nextStep)}</div>`;
  }
  body += `<div style="text-align:center;margin:28px 0 8px;">
      <a href="https://www.recrutas.ai/candidate-dashboard" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;">Open your feed</a>
    </div>`;
  return emailBase(body, "You're receiving this weekly summary because you used Recrutas this month.", unsubscribeUrl);
}
