/** The candidate welcome describes only what is live (phase 1): no employer chat, exams or recruiter claims. */
import { describe, it, expect } from 'vitest';
import { candidateWelcomeEmail } from '../server/lib/email';

describe('candidate welcome email', () => {
  const html = candidateWelcomeEmail('Jane <b>');

  it('links to the dashboard, both extension stores and the community', () => {
    expect(html).toContain('https://www.recrutas.ai/candidate-dashboard');
    expect(html).toContain('chromewebstore.google.com/detail/recrutas-auto-fill');
    expect(html).toContain('addons.mozilla.org/en-US/firefox/addon/recrutas-auto-fill');
    expect(html).toContain('https://www.reddit.com/r/recrutas/');
  });

  it('promises nothing that is not open yet', () => {
    for (const phrase of [/chat/i, /exam/i, /hiring manager/i, /eliminat/i, /24.hour/i, /recruiters?\b/i]) {
      expect(html, String(phrase)).not.toMatch(phrase);
    }
  });

  it('escapes the name', () => {
    expect(html).toContain('Jane &lt;b&gt;');
  });
});
