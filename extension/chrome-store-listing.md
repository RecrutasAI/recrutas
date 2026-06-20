# Chrome Web Store Listing — Recrutas Auto-Fill

> Prep doc for the Chrome Web Store submission. Chrome descriptions are **plain text only**
> (no HTML — same as AMO). Mirror of the live Firefox AMO listing, adapted to Chrome's
> field limits and required Privacy practices tab.

## Store listing tab

### Name (max 75 chars)
Recrutas Auto-Fill

### Summary / short description (max 132 chars)
One-click AI auto-fill for job applications, using your Recrutas profile. Works on Greenhouse, Lever, Workday & 30+ ATS.

### Detailed description (plain text, max 16,000 chars)
Stop copy-pasting your name, email, and work history into every job application. Recrutas Auto-Fill uses AI to fill entire application forms in one click using your Recrutas profile.

HOW IT WORKS:
1. Create a free account at recrutas.ai and upload your resume
2. Install this extension and sign in
3. Navigate to any job application page
4. Click the floating "Fill with Recrutas" button or press Alt+Shift+R
5. AI analyzes the form and fills every field — name, email, phone, work history, screening questions, even resume upload
6. Review the filled form and submit

FEATURES:
• One-click form filling powered by AI vision
• Auto-detects job application pages on 30+ ATS platforms
• Fills text fields, dropdowns, custom selects, checkboxes, and file uploads
• Writes tailored answers to screening questions using your real experience
• Keyboard shortcut (Alt+Shift+R) for instant filling
• Works with React, Angular, Vue, and custom form frameworks
• Resume auto-attached from your Recrutas profile

SUPPORTED PLATFORMS:
Greenhouse, Lever, Workday, Ashby, iCIMS, SmartRecruiters, Jobvite, BambooHR, Workable, Recruitee, Breezy, JazzHR, Taleo, SuccessFactors, and more. Also works on manual trigger for any website.

PRIVACY:
• Your data stays in your Recrutas account
• Screenshots are used only for form analysis and are not stored
• No tracking, no ads, no data selling
• Full privacy policy: https://recrutas.ai/privacy

Recrutas is free for candidates. No credit card required.

### Category
Workflow & Planning  (Chrome has no "Productivity"; this is the closest. Alt: "Tools")

### Language
English (United States)

### Graphic assets
- **Store icon:** 128×128 PNG — `extension/icons/icon128.png` ✓ (verified 128×128)
- **Screenshots:** 1280×800 or 640×400 PNG/JPEG, 1–5 required. ✓ READY — generated at exactly 1280×800 in `extension/screenshots/chrome/`:
  - `screenshots/chrome/1-popup.png` — popup centered on Recrutas-emerald canvas (portrait original was 640×922)
  - `screenshots/chrome/2-floating-button.png` — center-cropped + scaled from 2560×1720
  - `screenshots/chrome/3-mid-fill.png` — center-cropped + scaled from 2560×1720
  - (Originals preserved in `screenshots/`. Regenerate via the Pillow snippet in this repo's history, or re-shoot at a 1280×800 viewport.)
- **Small promo tile (optional, recommended):** 440×280 PNG — not yet made
- **Marquee promo tile (optional):** 1400×560 — not needed for launch

### URLs (all verified 200)
- Homepage: https://recrutas.ai
- Support: https://recrutas.ai/early-access
- Privacy policy: https://recrutas.ai/privacy

---

## Privacy practices tab (REQUIRED to publish)

### Single purpose
Recrutas Auto-Fill has a single purpose: to automatically complete online job application
forms using the information in the user's Recrutas profile, so candidates don't have to
re-type their details on every application.

### Permission justifications
- **storage** — Stores the user's Recrutas sign-in session locally so they stay logged in between page visits. No browsing data is stored.
- **activeTab** — Reads the form fields of the job-application page the user is currently on, only when they trigger a fill (button click or Alt+Shift+R), so the extension can populate that page.
- **scripting** — Injects the form-filling logic into the active job-application page to enter the user's profile values into the matching fields after they trigger a fill.
- **tabs** — Detects the active tab's URL to recognize when the user is on a supported job-application page and to coordinate the fill action with the page.
- **Host permissions (ATS/job-board domains + recrutas.ai)** — On supported job-board and ATS sites (Greenhouse, Lever, Workday, Ashby, etc.) the extension reads and fills the application form. The recrutas.ai hosts let it fetch the signed-in user's profile and resume to use as the fill source. The extension does not run on any other sites.

### Data usage — disclosures
Declare the following collected data types:
- **Personally identifiable information** — name, email, phone, mailing address (used to fill application fields)
- **Authentication information** — the user's Recrutas session token (stored locally to keep them signed in)
- **Website content** — the form fields / page content of the job-application page being filled (read transiently to map fields; screenshots used only for form analysis, not stored)

### Required certifications (check all three)
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

---

## Submission mechanics
- **One-time $5 developer registration fee** (Chrome Web Store dev account) — required, not yet paid.
- Upload package: `extension/dist/recrutas-chrome.zip` (MV3; produced by `build.sh`). Existing zip is fine content-wise (the only change since — PR #36 résumé/cover-letter — was server-side, not extension code), but rebuild fresh with `./build.sh` right before upload as good practice.
- Account creation + the $5 payment are human steps (Google login + CAPTCHA) — cannot be automated; same class of blocker as the AMO account.

## Blockers before submit
1. **$5 dev account** — register + pay (human; Google login + CAPTCHA can't be automated).
2. (Optional) 440×280 small promo tile.

All listing content (copy, privacy answers, 1280×800 screenshots, MV3 zip) is ready — only the
human dev-account step remains.

## Differences vs the Firefox/AMO listing
- Short description trimmed 250→132 chars (Chrome limit).
- "Productivity" → "Workflow & Planning" (Chrome category set).
- Chrome requires the explicit Privacy practices tab (single purpose + per-permission justifications + data disclosures + 3 certifications) — drafted above.
- Description body is identical plain text (already genericized "Gemini" → "AI vision").
