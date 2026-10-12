import { Resend } from 'resend';
import { candidateWelcomeEmail, sendEmail as sendBrandedEmail } from './lib/email';

// Derive frontend URL: explicit env var > Vercel auto-URL > localhost dev fallback
const FRONTEND_URL = process.env.FRONTEND_URL
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  || 'http://localhost:5000';

if (!process.env.RESEND_API_KEY) {
  console.warn("RESEND_API_KEY not configured - email sending will be disabled");
}

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

interface EmailParams {
  to: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
}

export async function sendEmail(params: EmailParams): Promise<boolean> {
  if (!process.env.RESEND_API_KEY || !resend) {
    console.log(`Development mode: Would send email to ${params.to} with subject "${params.subject}"`);
    return true;
  }

  try {
     
    const { error } = await resend.emails.send({
      to: params.to,
      from: params.from,
      subject: params.subject,
      text: params.text,
      html: params.html,
    } as any);
    if (error) {
      console.error('Resend email error:', error);
      return false;
    }
    console.log(`Email sent successfully to ${params.to}`);
    return true;
  } catch (error) {
    console.error('Resend email error:', error);
    return false;
  }
}

export async function sendPasswordResetEmail(email: string, resetToken: string): Promise<boolean> {
  const resetUrl = `${FRONTEND_URL}/reset-password?token=${resetToken}`;
  
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Password Reset - Recrutas</title>
        <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #000; color: #fff; padding: 20px; text-align: center; }
            .content { padding: 30px 20px; background: #f9f9f9; }
            .button { display: inline-block; padding: 12px 30px; background: #000; color: #fff; text-decoration: none; border-radius: 5px; margin: 20px 0; }
            .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Recrutas</h1>
                <p>Password Reset Request</p>
            </div>
            <div class="content">
                <h2>Reset Your Password</h2>
                <p>We received a request to reset your password for your Recrutas account.</p>
                <p>Click the button below to reset your password:</p>
                <a href="${resetUrl}" class="button">Reset Password</a>
                <p>If the button doesn't work, copy and paste this link into your browser:</p>
                <p><a href="${resetUrl}">${resetUrl}</a></p>
                <p><strong>Important:</strong> This link will expire in 1 hour for security reasons.</p>
                <p>If you didn't request this password reset, please ignore this email. Your password will remain unchanged.</p>
            </div>
            <div class="footer">
                <p>© 2024 Recrutas - AI-Powered Job Matching Platform</p>
                <p>This is an automated email. Please do not reply to this message.</p>
            </div>
        </div>
    </body>
    </html>
  `;

  const textContent = `
    Password Reset Request - Recrutas
    
    We received a request to reset your password for your Recrutas account.
    
    Click the link below to reset your password:
    ${resetUrl}
    
    Important: This link will expire in 1 hour for security reasons.
    
    If you didn't request this password reset, please ignore this email. Your password will remain unchanged.
    
    © 2024 Recrutas - AI-Powered Job Matching Platform
  `;

  return await sendEmail({
    to: email,
    from: 'noreply@recrutas.ai',
    subject: 'Reset Your Password - Recrutas',
    text: textContent,
    html: htmlContent,
  });
}

/** The candidate welcome: the shared Recrutas template, describing only what is live (lib/email.ts). */
export async function sendWelcomeEmail(email: string, firstName?: string): Promise<boolean> {
  try {
    await sendBrandedEmail({ to: email, subject: 'Welcome to Recrutas: your matches are ready', html: candidateWelcomeEmail(firstName) });
    return true;
  } catch (error) {
    console.error('Welcome email error:', error);
    return false;
  }
}

// ============================================
// TRANSACTIONAL EMAIL TEMPLATES
// ============================================

const baseStyles = `
  body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
  .container { max-width: 600px; margin: 0 auto; padding: 20px; }
  .header { background: #000; color: #fff; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
  .content { padding: 30px 20px; background: #f9f9f9; }
  .button { display: inline-block; padding: 12px 30px; background: #000; color: #fff; text-decoration: none; border-radius: 5px; margin: 20px 0; }
  .button:hover { background: #333; }
  .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; border-radius: 0 0 8px 8px; background: #f0f0f0; }
  .highlight { background: #e8f5e9; padding: 15px; border-radius: 5px; margin: 15px 0; }
  .warning { background: #fff3e0; padding: 15px; border-radius: 5px; margin: 15px 0; }
  .info { background: #e3f2fd; padding: 15px; border-radius: 5px; margin: 15px 0; }
`;

/**
 * Send application status update email
 */
export async function sendApplicationStatusEmail(
  email: string,
  candidateName: string,
  jobTitle: string,
  companyName: string,
  status: 'viewed' | 'shortlisted' | 'rejected' | 'accepted' | 'interview_scheduled',
  additionalInfo?: { feedback?: string; nextSteps?: string; interviewDate?: string }
): Promise<boolean> {
  const statusConfig: Record<string, { subject: string; headline: string; message: string; tone: string }> = {
    viewed: {
      subject: `Your application for ${jobTitle} was viewed`,
      headline: 'Your Application Was Viewed!',
      message: `Great news! ${companyName} has reviewed your application for the ${jobTitle} position. This is a positive sign that your profile caught their attention.`,
      tone: 'info'
    },
    shortlisted: {
      subject: `Congratulations! You've been shortlisted for ${jobTitle}`,
      headline: 'You\'ve Been Shortlisted!',
      message: `Exciting news! ${companyName} has shortlisted you for the ${jobTitle} position. You're among the top candidates being considered.`,
      tone: 'highlight'
    },
    rejected: {
      subject: `Update on your ${jobTitle} application`,
      headline: 'Application Update',
      message: `Thank you for your interest in the ${jobTitle} position at ${companyName}. After careful consideration, they have decided to move forward with other candidates. This doesn't reflect on your abilities - keep applying!`,
      tone: 'warning'
    },
    accepted: {
      subject: `Congratulations! Your application for ${jobTitle} was accepted`,
      headline: 'Congratulations!',
      message: `Amazing news! ${companyName} has accepted your application for the ${jobTitle} position. They will be reaching out to discuss next steps.`,
      tone: 'highlight'
    },
    interview_scheduled: {
      subject: `Interview scheduled for ${jobTitle} at ${companyName}`,
      headline: 'Interview Scheduled!',
      message: `Your interview for the ${jobTitle} position at ${companyName} has been scheduled${additionalInfo?.interviewDate ? ` for ${additionalInfo.interviewDate}` : ''}. Make sure to prepare and good luck!`,
      tone: 'highlight'
    }
  };

  const config = statusConfig[status];
  if (!config) {return false;}

  const frontendUrl = FRONTEND_URL;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>${baseStyles}</style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Recrutas</h1>
                <p>Application Update</p>
            </div>
            <div class="content">
                <h2>Hi ${candidateName},</h2>
                <div class="${config.tone}">
                    <h3>${config.headline}</h3>
                    <p>${config.message}</p>
                </div>
                ${additionalInfo?.feedback ? `
                <div class="info">
                    <strong>Feedback:</strong>
                    <p>${additionalInfo.feedback}</p>
                </div>
                ` : ''}
                ${additionalInfo?.nextSteps ? `
                <div class="info">
                    <strong>Next Steps:</strong>
                    <p>${additionalInfo.nextSteps}</p>
                </div>
                ` : ''}
                <p>View your application status and track all your applications:</p>
                <a href="${frontendUrl}/candidate-dashboard" class="button">View Dashboard</a>
            </div>
            <div class="footer">
                <p>© 2024 Recrutas - AI-Powered Job Matching</p>
                <p>You received this email because you applied for a job through Recrutas.</p>
            </div>
        </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: email,
    from: 'notifications@recrutas.ai',
    subject: config.subject,
    html: htmlContent,
  });
}

/**
 * Send interview scheduled email with details
 */
export async function sendInterviewScheduledEmail(
  email: string,
  candidateName: string,
  jobTitle: string,
  companyName: string,
  interviewDate: string,
  interviewTime: string,
  interviewType: 'video' | 'phone' | 'in-person',
  meetingLink?: string,
  location?: string,
  interviewerName?: string
): Promise<boolean> {
  const frontendUrl = FRONTEND_URL;

  const typeDetails: Record<string, string> = {
    video: meetingLink ? `Join via: <a href="${meetingLink}">${meetingLink}</a>` : 'Video call details will be provided.',
    phone: 'You will receive a call at the number on your profile.',
    'in-person': location ? `Location: ${location}` : 'Location details will be provided.'
  };

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>${baseStyles}</style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Recrutas</h1>
                <p>Interview Scheduled</p>
            </div>
            <div class="content">
                <h2>Hi ${candidateName},</h2>
                <div class="highlight">
                    <h3>Your Interview is Confirmed!</h3>
                    <p>You have an interview scheduled for the <strong>${jobTitle}</strong> position at <strong>${companyName}</strong>.</p>
                </div>
                <div class="info">
                    <h4>Interview Details:</h4>
                    <ul>
                        <li><strong>Date:</strong> ${interviewDate}</li>
                        <li><strong>Time:</strong> ${interviewTime}</li>
                        <li><strong>Type:</strong> ${interviewType.charAt(0).toUpperCase() + interviewType.slice(1)} Interview</li>
                        ${interviewerName ? `<li><strong>Interviewer:</strong> ${interviewerName}</li>` : ''}
                    </ul>
                    <p>${typeDetails[interviewType]}</p>
                </div>
                <div class="warning">
                    <h4>Tips for Success:</h4>
                    <ul>
                        <li>Research ${companyName} and their products/services</li>
                        <li>Review the job description and prepare relevant examples</li>
                        <li>Test your equipment (for video calls) 15 minutes early</li>
                        <li>Prepare questions to ask the interviewer</li>
                    </ul>
                </div>
                <a href="${frontendUrl}/candidate-dashboard" class="button">View Details</a>
            </div>
            <div class="footer">
                <p>© 2024 Recrutas - AI-Powered Job Matching</p>
                <p>Good luck with your interview!</p>
            </div>
        </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: email,
    from: 'notifications@recrutas.ai',
    subject: `Interview Scheduled: ${jobTitle} at ${companyName} - ${interviewDate}`,
    html: htmlContent,
  });
}

/**
 * Send new job match notification email
 */
export async function sendNewMatchEmail(
  email: string,
  candidateName: string,
  jobTitle: string,
  companyName: string,
  matchScore: number,
  skills: string[],
  jobId: number
): Promise<boolean> {
  const frontendUrl = FRONTEND_URL;

  const matchQuality = matchScore >= 85 ? 'Excellent' : matchScore >= 70 ? 'Strong' : 'Good';
  const matchColor = matchScore >= 85 ? '#4caf50' : matchScore >= 70 ? '#2196f3' : '#ff9800';

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>${baseStyles}</style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Recrutas</h1>
                <p>New Job Match Found!</p>
            </div>
            <div class="content">
                <h2>Hi ${candidateName},</h2>
                <div class="highlight">
                    <h3>New ${matchQuality} Match Found!</h3>
                    <p>Our AI has found a job that matches your profile:</p>
                </div>
                <div class="info">
                    <h3>${jobTitle}</h3>
                    <p><strong>${companyName}</strong></p>
                    <p style="font-size: 24px; color: ${matchColor}; font-weight: bold;">${matchScore}% Match</p>
                    ${skills.length > 0 ? `
                    <p><strong>Matching Skills:</strong></p>
                    <p>${skills.slice(0, 5).join(' • ')}</p>
                    ` : ''}
                </div>
                <a href="${frontendUrl}/candidate-dashboard" class="button">View Job Details</a>
                <p style="color: #666; font-size: 14px;">Don't miss out - great candidates often apply within 24 hours!</p>
            </div>
            <div class="footer">
                <p>© 2024 Recrutas - AI-Powered Job Matching</p>
                <p>You received this because you have job alerts enabled.</p>
            </div>
        </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: email,
    from: 'notifications@recrutas.ai',
    subject: `${matchQuality} Match (${matchScore}%): ${jobTitle} at ${companyName}`,
    html: htmlContent,
  });
}

/**
 * Send exam completion notification to talent owner
 */
export async function sendExamCompletedEmail(
  email: string,
  talentOwnerName: string,
  candidateName: string,
  jobTitle: string,
  score: number,
  totalQuestions: number,
  correctAnswers: number
): Promise<boolean> {
  const frontendUrl = FRONTEND_URL;

  const scoreQuality = score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : 'Below Average';
  const scoreColor = score >= 80 ? '#4caf50' : score >= 60 ? '#ff9800' : '#f44336';

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>${baseStyles}</style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Recrutas</h1>
                <p>Exam Completed</p>
            </div>
            <div class="content">
                <h2>Hi ${talentOwnerName},</h2>
                <div class="${score >= 80 ? 'highlight' : 'info'}">
                    <h3>Screening Exam Completed</h3>
                    <p><strong>${candidateName}</strong> has completed the screening exam for <strong>${jobTitle}</strong>.</p>
                </div>
                <div class="info">
                    <h4>Results Summary:</h4>
                    <p style="font-size: 32px; color: ${scoreColor}; font-weight: bold; text-align: center;">${score}%</p>
                    <p style="text-align: center; color: #666;">${scoreQuality} Performance</p>
                    <ul>
                        <li><strong>Score:</strong> ${correctAnswers}/${totalQuestions} questions correct</li>
                        <li><strong>Performance Level:</strong> ${scoreQuality}</li>
                    </ul>
                </div>
                ${score >= 80 ? `
                <div class="highlight">
                    <p>⭐ <strong>Top Performer!</strong> This candidate scored in the top tier. Consider reaching out soon.</p>
                </div>
                ` : ''}
                <a href="${frontendUrl}/talent-dashboard" class="button">Review Candidate</a>
            </div>
            <div class="footer">
                <p>© 2024 Recrutas - AI-Powered Job Matching</p>
            </div>
        </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: email,
    from: 'notifications@recrutas.ai',
    subject: `Exam Completed: ${candidateName} scored ${score}% on ${jobTitle}`,
    html: htmlContent,
  });
}

/**
 * Send new message notification
 */
export async function sendNewMessageEmail(
  email: string,
  recipientName: string,
  senderName: string,
  messagePreview: string,
  jobTitle?: string
): Promise<boolean> {
  const frontendUrl = FRONTEND_URL;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>${baseStyles}</style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Recrutas</h1>
                <p>New Message</p>
            </div>
            <div class="content">
                <h2>Hi ${recipientName},</h2>
                <p>You have a new message from <strong>${senderName}</strong>${jobTitle ? ` regarding the <strong>${jobTitle}</strong> position` : ''}.</p>
                <div class="info">
                    <p><em>"${messagePreview.length > 150 ? messagePreview.substring(0, 150) + '...' : messagePreview}"</em></p>
                </div>
                <a href="${frontendUrl}/chat" class="button">Reply Now</a>
            </div>
            <div class="footer">
                <p>© 2024 Recrutas - AI-Powered Job Matching</p>
            </div>
        </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: email,
    from: 'notifications@recrutas.ai',
    subject: `New message from ${senderName}${jobTitle ? ` about ${jobTitle}` : ''}`,
    html: htmlContent,
  });
}