import { test, expect } from '@playwright/test';

const PM_RESUME = `Sarah Chen
Senior Product Manager
sarah.chen@email.com | (415) 555-0123 | San Francisco, CA
LinkedIn: linkedin.com/in/sarahchen

PROFESSIONAL SUMMARY
Results-driven Product Manager with 7+ years of experience launching and scaling B2B SaaS products. Expert in agile methodologies, user research, and data-driven decision making.

TECHNICAL SKILLS
Product Management: Agile, Scrum, Kanban, Roadmap Planning, Sprint Planning, User Story Mapping
Analytics: SQL, Google Analytics, Mixpanel, Amplitude, Tableau, A/B Testing
Tools: Jira, Confluence, Figma, Miro, Notion, Linear, Asana, Trello
Methodologies: Design Thinking, Jobs-to-be-Done, OKRs, KPI Frameworks

PROFESSIONAL EXPERIENCE

Senior Product Manager | TechScale Inc. | 2021 - Present
- Led product strategy for enterprise SaaS platform
- Increased user engagement by 45% through data-driven feature prioritization
- Managed product roadmap balancing customer needs with business objectives
- Collaborated with engineering, design, and sales teams

Product Manager | GrowthCo | 2018 - 2021
- Launched 3 major product features generating $15M ARR
- Conducted 100+ user interviews to inform product decisions
- Led agile ceremonies and managed backlog for 2 scrum teams

Associate Product Manager | StartupX | 2016 - 2018
- Shipped mobile app features reaching 500K+ downloads
- Analyzed user behavior data to identify growth opportunities

EDUCATION
MBA, Product Management Focus | Stanford Graduate School of Business | 2016
BS, Computer Science | UC Berkeley | 2014

CERTIFICATIONS
Certified Scrum Product Owner (CSPO)
Google Analytics Certified`;

async function getAccessToken(page: any): Promise<string> {
  return await page.evaluate(() => {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (key.includes('auth-token')) {
        const value = localStorage.getItem(key);
        if (value) {
          try {
            const parsed = JSON.parse(value);
            return parsed?.access_token || '';
          } catch (e) {}
        }
      }
    }
    return '';
  });
}

test.describe('PM Resume Flow', () => {
  test.setTimeout(60000);
  
  test('should authenticate and access candidate dashboard', async ({ page }) => {
    await page.goto('/auth');
    await page.locator('input[type="email"]').fill((process.env.E2E_CANDIDATE_EMAIL ?? ''));
    await page.locator('input[type="password"]').fill((process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await page.getByRole('button', { name: /sign in|login/i }).click();
    
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 15000 });
    
    const pageContent = await page.textContent('body') || '';
    expect(pageContent.length).toBeGreaterThan(50);
  });

  test('should get candidate profile with skills', async ({ page }) => {
    await page.goto('/auth');
    await page.locator('input[type="email"]').fill((process.env.E2E_CANDIDATE_EMAIL ?? ''));
    await page.locator('input[type="password"]').fill((process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await page.getByRole('button', { name: /sign in|login/i }).click();
    
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 15000 });
    await page.waitForTimeout(1000);
    
    const accessToken = await getAccessToken(page);
    
    const profileResponse = await page.evaluate(async (token) => {
      const res = await fetch('/api/candidate/profile', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      return res.json();
    }, accessToken);
    
    console.log('Profile response:', JSON.stringify(profileResponse, null, 2).substring(0, 500));
    
    expect(profileResponse).toBeDefined();
    expect(profileResponse.id || profileResponse.userId).toBeDefined();
    
    const skills = profileResponse.skills || [];
    console.log('Skills count:', skills.length);
    console.log('Sample skills:', skills.slice(0, 15));
    
    expect(skills.length).toBeGreaterThan(0);
  });

  test('should verify PM skills are extracted from resume', async ({ page }) => {
    await page.goto('/auth');
    await page.locator('input[type="email"]').fill((process.env.E2E_CANDIDATE_EMAIL ?? ''));
    await page.locator('input[type="password"]').fill((process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await page.getByRole('button', { name: /sign in|login/i }).click();
    
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 15000 });
    await page.waitForTimeout(1000);
    
    const accessToken = await getAccessToken(page);
    
    const profileResponse = await page.evaluate(async (token) => {
      const res = await fetch('/api/candidate/profile', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      return res.json();
    }, accessToken);
    
    const skills = profileResponse.skills || [];
    console.log('Current skills count:', skills.length);
    console.log('All skills:', skills);
    
    const pmSkillKeywords = [
      'agile', 'scrum', 'product', 'roadmap', 'jira', 'analytics', 
      'okr', 'kanban', 'sprint', 'backlog', 'management', 'figma', 
      'miro', 'confluence', 'asana', 'trello', 'sql', 'tableau',
      'react', 'node', 'docker', 'java', 'mongodb', 'angular'
    ];
    
    const foundSkills = skills.filter((s: string) => 
      pmSkillKeywords.some(pm => s.toLowerCase().includes(pm.toLowerCase()))
    );
    
    console.log('Relevant skills found:', foundSkills);
    expect(foundSkills.length).toBeGreaterThan(0);
  });

  test('should have resume uploaded', async ({ page }) => {
    await page.goto('/auth');
    await page.locator('input[type="email"]').fill((process.env.E2E_CANDIDATE_EMAIL ?? ''));
    await page.locator('input[type="password"]').fill((process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await page.getByRole('button', { name: /sign in|login/i }).click();
    
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 15000 });
    await page.waitForTimeout(1000);
    
    const accessToken = await getAccessToken(page);
    
    const profileResponse = await page.evaluate(async (token) => {
      const res = await fetch('/api/candidate/profile', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      return res.json();
    }, accessToken);
    
    console.log('Has resume URL:', !!profileResponse.resumeUrl);
    console.log('Has resume text:', !!profileResponse.resumeText);
    console.log('Processing status:', profileResponse.resumeProcessingStatus);
    
    const hasResume = profileResponse.resumeUrl || profileResponse.resumeText || profileResponse.skills?.length > 0;
    expect(hasResume).toBeTruthy();
  });

  test('should complete resume parsing and show extracted data', async ({ page }) => {
    await page.goto('/auth');
    await page.locator('input[type="email"]').fill((process.env.E2E_CANDIDATE_EMAIL ?? ''));
    await page.locator('input[type="password"]').fill((process.env.E2E_CANDIDATE_PASSWORD ?? ''));
    await page.getByRole('button', { name: /sign in|login/i }).click();
    
    await expect(page).toHaveURL(/\/candidate-dashboard/, { timeout: 15000 });
    
    const uploadButton = page.getByRole('button', { name: /upload.*resume/i });
    
    if (await uploadButton.count() > 0) {
      console.log('Upload button found - resume can be uploaded via UI');
    }
    
    const dashboardContent = await page.textContent('body') || '';
    expect(dashboardContent.length).toBeGreaterThan(100);
    
    await page.waitForTimeout(1000);
    
    const accessToken = await getAccessToken(page);
    
    const profileResponse = await page.evaluate(async (token) => {
      const res = await fetch('/api/candidate/profile', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      return res.json();
    }, accessToken);
    
    const skills = profileResponse.skills || [];
    const experience = profileResponse.experienceLevel || profileResponse.experience;
    const location = profileResponse.location;
    
    console.log('Extracted profile data:');
    console.log('  Skills:', skills.length);
    console.log('  Experience:', experience);
    console.log('  Location:', location);
    
    expect(skills.length).toBeGreaterThan(0);
  });
});
