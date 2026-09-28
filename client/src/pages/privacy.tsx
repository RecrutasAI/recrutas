import { LegalPage } from "@/components/site/site-shell";

export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" updated="January 2025">

          <section>
            <h2>1. Information We Collect</h2>
            <p>
              We collect information you provide directly to us, such as when you create an account,
              upload your resume, apply for jobs, or communicate with employers through our platform.
            </p>
            <ul>
              <li>Account information (name, email, password)</li>
              <li>Profile information (resume, skills, work experience)</li>
              <li>Job preferences and application history</li>
              <li>Communications with employers</li>
            </ul>
          </section>

          <section>
            <h2>2. How We Use Your Information</h2>
            <p>We use the information we collect to:</p>
            <ul>
              <li>Provide, maintain, and improve our services</li>
              <li>Match you with relevant job opportunities</li>
              <li>Facilitate communication between candidates and employers</li>
              <li>Send you updates about jobs and platform features</li>
              <li>Protect against fraud and abuse</li>
            </ul>
          </section>

          <section>
            <h2>3. Information Sharing</h2>
            <p>
              We share your information with employers when you apply for jobs or when employers
              search for candidates matching your profile (if you've opted in to be discoverable).
            </p>
            <p>
              We do not sell your personal information to third parties.
            </p>
          </section>

          <section>
            <h2>4. Data Security</h2>
            <p>
              We implement appropriate security measures to protect your personal information
              against unauthorized access, alteration, disclosure, or destruction.
            </p>
          </section>

          <section>
            <h2>5. Your Rights</h2>
            <p>You have the right to:</p>
            <ul>
              <li>Access and download your personal data</li>
              <li>Update or correct your information</li>
              <li>Delete your account and associated data</li>
              <li>Opt out of marketing communications</li>
            </ul>
          </section>

          <section>
            <h2>6. Contact Us</h2>
            <p>
              If you have any questions about this Privacy Policy, please contact us at{" "}
              <a href="mailto:privacy@recrutas.ai">
                privacy@recrutas.ai
              </a>
            </p>
          </section>
    </LegalPage>
  );
}
