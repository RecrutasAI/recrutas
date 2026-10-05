import { LegalPage } from "@/components/site/site-shell";

export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" updated="October 5, 2026">

          <section>
            <p>
              Recrutas helps job seekers in the United States find live jobs, apply to them, and
              learn what happened after they applied. This policy explains what we collect, why,
              who processes it for us, and the choices you have. It covers the Recrutas website and
              app, the Recrutas Auto-Fill browser extension, our emails, and the Recrutas MCP
              connector for AI tools.
            </p>
          </section>

          <section>
            <h2>1. Information we collect</h2>
            <p><strong>What you give us</strong></p>
            <ul>
              <li>Account details: name, email address, password (stored by our sign-in provider, never in plain text), or your Google account name and email if you sign in with Google.</li>
              <li>Your resume file and what we read from it: contact details, skills, job titles, work history and education.</li>
              <li>Profile and preferences: location, work type, salary range, job preferences.</li>
              <li>Application answers you choose to give, such as US work authorization, visa sponsorship, citizenship, security clearance and phone number. These are used to fill application forms and to check job requirements.</li>
              <li>Jobs you save, apply to, or record as applied, and any status you set on them.</li>
              <li>Messages you send through Recrutas, and anything you send to support.</li>
            </ul>
            <p><strong>What the browser extension handles</strong></p>
            <ul>
              <li>When you click Fill (or press the shortcut) on a job application page, the extension reads that form's fields and takes a screenshot of the visible page, and sends them to Recrutas to work out which field is which. Screenshots are processed to fill the form and are not stored.</li>
              <li>When it sees an application's confirmation page, it records the job posting's address, title and company, so we can track that application for you.</li>
              <li>It keeps your sign-in and a copy of your profile on your device. It runs only on job application sites and on recrutas.ai, does not read other browsing, and never submits a form for you.</li>
            </ul>
            <p><strong>What we collect automatically</strong></p>
            <ul>
              <li>Usage events such as pages viewed and features used, through our analytics provider, linked to your account once you sign in.</li>
              <li>Technical data needed to run and protect the service: IP address, browser type, error reports, and a CAPTCHA check at sign-in.</li>
            </ul>
            <p>
              We also collect job postings from employers' public career pages. Those are listings,
              not personal information about you.
            </p>
          </section>

          <section>
            <h2>2. How we use it</h2>
            <ul>
              <li>To match you with live jobs and show whether each one fits your stated requirements (Apply, Stretch or Skip).</li>
              <li>To fill application forms when you ask, and to attach your resume to them.</li>
              <li>To track the jobs you applied to and tell you when a posting is taken down or reposted, and why you may not be hearing back.</li>
              <li>To send you the emails you've asked for and account emails (sign-in, password reset). You can turn off non-essential emails in Settings or with the unsubscribe link in any of them.</li>
              <li>To keep the service secure, prevent abuse, fix problems, and improve Recrutas.</li>
            </ul>
            <p>
              We do not use your information for advertising, and we do not make hiring decisions
              about you.
            </p>
          </section>

          <section>
            <h2>3. AI processing</h2>
            <p>
              We use AI services to read your resume, to identify the fields on application forms,
              and to suggest form answers. To do that, your resume text, the form's fields and
              screenshot, and relevant parts of your profile are sent to one of these providers:
              Groq, Google (Gemini), OpenRouter, or Hugging Face. They process it to return a result
              to us under their terms for business customers. Job matching itself runs on our own
              servers.
            </p>
          </section>

          <section>
            <h2>4. Who we share it with</h2>
            <ul>
              <li><strong>Employers you apply to.</strong> When you apply on an employer's own site, what you submit goes to that employer under their privacy policy; the extension only fills the form, and you choose whether to submit. When you apply to a job posted on Recrutas, the employer sees your application and profile.</li>
              <li><strong>Service providers</strong> who run parts of Recrutas for us: Vercel (website hosting), Hetzner (our database and servers, in the United States), Supabase (sign-in and resume file storage), Cloudflare (CAPTCHA and encrypted backups), Resend (email), PostHog (product analytics), and the AI providers above.</li>
              <li><strong>AI tools you connect.</strong> If you create a token for the MCP connector, the AI tool you connect (for example Claude Code or Cursor) can read your matches, job details and application history. You can revoke a token at any time in Settings.</li>
              <li><strong>When the law requires it,</strong> or to protect the rights and safety of our users or Recrutas.</li>
            </ul>
            <p>
              We do not sell your personal information, and we do not share it for cross-context
              behavioral advertising.
            </p>
          </section>

          <section>
            <h2>5. How long we keep it</h2>
            <p>
              We keep your information while your account is open. If you delete your account (in
              Settings), we delete your account, profile, applications and resume file right away.
              Copies in our encrypted backups are overwritten on a rolling schedule within 30 days.
              Usage analytics linked to your account are kept for our analytics provider's standard
              retention period.
            </p>
          </section>

          <section>
            <h2>6. Security</h2>
            <p>
              Data is encrypted in transit, resumes are stored privately and opened only through
              short-lived links, backups are encrypted, and MCP tokens are stored only as hashes. No
              system is perfectly secure; if a breach affects you, we will tell you as the law
              requires.
            </p>
          </section>

          <section>
            <h2>7. Your choices and rights</h2>
            <ul>
              <li>Update your profile, preferences and application answers at any time in the app.</li>
              <li>Delete your account and data in Settings.</li>
              <li>Turn off emails in Settings or with any unsubscribe link.</li>
              <li>Revoke AI-tool (MCP) tokens in Settings, and remove the extension from your browser at any time.</li>
              <li>Ask for a copy of your data, a correction, or a deletion by emailing us. Depending on where you live (for example California), you may have further rights under state law; we honor them and will not treat you differently for using them.</li>
            </ul>
          </section>

          <section>
            <h2>8. Children</h2>
            <p>
              Recrutas is for adults looking for work. It is not directed at children under 16, and
              we do not knowingly collect their information.
            </p>
          </section>

          <section>
            <h2>9. Changes</h2>
            <p>
              We will update this page when our practices change and change the date at the top. If
              a change is significant, we will tell you by email or in the app.
            </p>
          </section>

          <section>
            <h2>10. Contact us</h2>
            <p>
              Questions or requests: <a href="mailto:support@recrutas.ai">support@recrutas.ai</a>
            </p>
          </section>
    </LegalPage>
  );
}
