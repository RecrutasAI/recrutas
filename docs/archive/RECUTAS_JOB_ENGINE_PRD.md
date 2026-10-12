### PRD: The Hyper-Relevance Job Feed Engine

**Version:** 1.0
**Status:** Final Draft
**Author:** Gemini Architect
**Date:** January 25, 2026

### 1. Introduction & Problem Statement

#### **1.1. The Problem**

Our current job feed successfully aggregates jobs from multiple sources, but it faces three primary challenges that limit user trust and engagement:

1.  **Data Freshness:** Users frequently encounter stale or expired job listings. Applying to a job only to find it’s no longer available is a frustrating experience that erodes confidence in our platform.
2.  **Relevance Ceiling:** Our current relevance matching is good, but it doesn't deeply understand the user's intent or the semantic nuances of a job description. As a result, users may see jobs that are only superficially relevant and miss opportunities that are a perfect fit but use different keywords.
3.  **Source Authenticity & Latency:** While we aggregate broadly, the current mix of sources doesn't consistently prioritize direct-from-company career pages, which are often the most accurate and up-to-date. This can introduce data latency and reduce overall job quality.

#### **1.2. The Vision**

We will evolve our job feed from a simple aggregator into a **real-time, predictive career co-pilot**. This new engine will ensure that every job a user sees is not only **active, directly sourced from the employer, and available**, but also **deemply relevant** to their explicit skills and implicit career aspirations. We will build the most trusted and intelligent job feed in the industry.

### 2. Goals & Objectives

The primary goals of this initiative are:

*   **Increase User Trust:** Drastically reduce the number of encounters with stale or inactive job listings by prioritizing and verifying direct-from-company sources.
*   **Boost User Engagement:** Increase the rate at which users interact with job listings (apply, save).
*   **Improve Long-Term Retention:** Make the platform an indispensable tool for career growth, encouraging users to return even when not actively looking for a job.
*   **Maximize Source Authenticity:** Ensure a significant percentage of displayed jobs are verified directly from company career pages.
*   **Establish Market Leadership:** Create a technologically defensible feature that sets our platform apart from competitors.

### 3. User Personas

This project will primarily serve two key user personas:

*   **The Active Seeker (e.g., "Alex"):** Alex has recently decided to look for a new role. They use our platform daily, want to see the newest jobs first, and get frustrated by expired listings. They need an efficient, trustworthy feed that surfaces the best opportunities right away, ideally directly from the hiring company.
*   **The Passive Browser (e.g., "Priya"):** Priya is content in her current role but is open to new opportunities. She visits our platform weekly to keep an eye on the market. She needs a feed that can intelligently recommend a "perfect fit" job that would entice her to consider a move, with the assurance that the job is truly open and from the direct source.

### 4. Features & Requirements

#### **Epic 1: Data Foundation - The Single Source of Truth & Liveness**

**Phase 1 Goal: Establish a robust, high-quality, and trustworthy data foundation for all job listings, emphasizing authenticity and liveness.**

**Feature 1.1: The "Job Liveness" Service**

*   **Objective:** Proactively verify the active status of every external job listing to eliminate stale and expired entries from the feed. This directly addresses user frustration and builds trust.
*   **Requirements:**
    *   **REQ-1.1.1: URL Re-validation Mechanism:** Implement a dedicated microservice ("Job Status Prober") that periodically re-visits the `externalUrl` of ingested jobs from *all* external sources.
    *   **REQ-1.1.2: Stale Job Detection:** The service must detect if a job URL leads to:
        *   A 404 "Not Found" error.
        *   A redirect to a generic careers page (not the specific job).
        *   Text indicating the position is filled or no longer available (e.g., "This job has been removed," "Position closed").
    *   **REQ-1.1.3: Status Update:** If any stale condition is met, the job's internal status must be updated to `inactive` (or `expired`), effectively removing it from candidate-facing feeds.
    *   **REQ-1.1.4: Verification Schedule:** Implement a configurable schedule for re-validation, prioritizing jobs by recency and source trust score (e.g., check newer jobs and those from less reliable sources more frequently).
*   **User Story:** "As a candidate, I expect to only see job listings that are currently open and available, so I don't waste my time applying to them."

**Feature 1.2: Advanced Data Standardization & Source Prioritization**

*   **Objective:** Create a canonical, highly structured representation for all job data, and prioritize direct-from-company sources for maximum accuracy and freshness.
*   **Requirements:**
    *   **REQ-1.2.1: Company Canonicalization:** Implement a service that maps variations of company names (e.g., "Google LLC", "Google Inc.", "Alphabet") to a single, canonical internal company ID and name. This should leverage external data sources where available.
    *   **REQ-1.2.2: Location Normalization & Geocoding:** Standardize job locations to a consistent format (e.g., "San Francisco, CA, USA") and include latitude/longitude coordinates. All locations must be verified to be US-based if required.
    *   **REQ-1.2.3: Role & Skill Taxonomy:** Develop an internal, dynamic taxonomy for job roles and skills. All incoming job titles and descriptions must be processed to map to this taxonomy, including inferring related skills not explicitly mentioned.
    *   **REQ-1.2.4: Source Trust & Priority Scoring:** Implement a system to assign a dynamic "Trust Score" to each job source. Direct-from-company career pages (via `UniversalJobScraper`) and high-fidelity APIs receive higher scores. This score will influence verification frequency (REQ-1.1.4) and overall job ranking.
    *   **REQ-1.2.5: AI-Powered Data Enrichment (Advanced):** Enhance the existing AI enrichment to infer additional job attributes from the description, such as:
        *   Seniority Level (Junior, Mid, Senior, Lead)
        *   Work Type (Remote, Hybrid, Onsite - with higher confidence)
        *   Industry/Domain Classification
        *   Potential "urgency" signals (e.g., "urgently hiring")
    *   **REQ-1.2.6: Unified Job Ingestion:** All jobs, regardless of origin (internal jobs posted by recruiters on our platform or external jobs from any source), **must** be transformed into the same, single canonical job schema. There should be no distinction in data structure between internal and external jobs once they enter the ranking pipeline.
    *   **REQ-1.2.7: Internal Source Prioritization:** Internal jobs should be assigned the highest possible `Source Trust Score` by default, ensuring they are treated as highly authoritative and fresh.
*   **User Story:** "As a candidate, I don't care where a job came from; I just want to see the best opportunities for me, whether they were posted on your platform or elsewhere."

---

#### **Epic 2: The Resume-Centric Relevance Engine**

**Phase 2 Goal: Generate a highly relevant, personalized job feed by deeply understanding the candidate's resume and matching it against our enriched job data.**

**Feature 2.1: Advanced Resume Parsing and Structuring**

*   **Objective:** Transform the candidate's resume from an unstructured document into a rich, structured, and vectorized "Candidate Profile" that serves as the definitive source of truth for matching.
*   **Requirements:**
    *   **REQ-2.1.1: Deep Resume Parsing:** Implement an advanced NLP service to parse uploaded resumes (PDF, DOCX). This service must go beyond keyword extraction and structure the content into a canonical schema, identifying and separating:
        *   **Work Experience:** Each role with its associated company, title, dates, and a summary of responsibilities and accomplishments.
        *   **Skills:** A comprehensive list of all skills, which will be mapped to our internal Skill Taxonomy (from REQ-1.2.3).
        *   **Education:** Institutions, degrees, and dates.
        *   **Projects:** Any personal or professional projects listed.
    *   **REQ-2.1.2: Candidate Vectorization:** Once parsed, the structured resume data (especially the summaries of experience and skills) will be encoded into a primary, high-dimensional **"Candidate Vector."** This vector is the mathematical representation of the candidate's professional identity and is the cornerstone of our matching algorithm.
    *   **REQ-2.1.3: Profile Review and Verification (UI):** Provide a UI where the candidate can review the parsed, structured data from their resume and make corrections or additions. This builds trust and provides valuable, clean training data for the parsing model.
*   **User Story:** "As a candidate, I want the platform to deeply and accurately understand my entire resume—including my accomplishments and the context of my roles—so it can find the best possible matches for my experience."

**Feature 2.2: The Hybrid Ranking Algorithm (Resume-to-Job)**

*   **Objective:** Rank jobs in the feed based on a combination of deep semantic relevance to the candidate's resume, job liveness, recency, and subtle personalization signals.
*   **Requirements:**
    *   **REQ-2.2.1: Core Semantic Relevance Score:** The primary ranking factor will be the **semantic similarity** (e.g., cosine similarity) between the **Candidate Vector** (from REQ-2.1.2) and the **Job Vector** (from the enriched job data in Epic 1). This ensures that jobs are matched based on the meaning of the experience, not just keywords.
    *   **REQ-2.2.2: Multi-Factor Re-Ranking:** The initial list of semantically relevant jobs will be re-ranked using a weighted formula that incorporates the crucial signals from Epic 1 and secondary user-intent signals. The formula will be structured like:
        `FinalScore = w1*SemanticRelevance + w2*Recency + w3*Liveness + w4*Personalization`
    *   **REQ-2.2.3: Liveness & Recency Integration:** The `Liveness Score` (from the "Job Status Prober") and `Recency Score` (from our date analysis) will be heavily weighted to push active, new jobs to the top.
    *   **REQ-2.2.4: Behavioral Personalization (as a "Tie-Breaker"):** User interaction data (clicks, saves, hides) will be used as a secondary factor. Its primary role is to refine the ranking of jobs that have *similar relevance scores* based on the resume. For example:
        *   If two jobs are an 85% match to the resume, but the user has recently saved jobs from one of the companies, that job gets a slight boost.
        *   This data helps us understand the user's *current focus* without overriding the ground truth of their resume.
    *   **REQ-2.2.5: Curated Daily Output:** The ranking algorithm must be optimized to consistently identify and present the **top 15 most relevant jobs per user per day**. If fewer than 15 highly relevant jobs are found, the system should present the available ones, not fill with irrelevant matches.
    *   **REQ-2.2.6: Source-Agnostic Ranking:** The ranking algorithm must operate exclusively on the unified job schema. It will rank all jobs based on the calculated `FinalScore` without any bias toward a job's origin (internal vs. external), ensuring a level playing field.
*   **User Story:** "As a candidate, I want the jobs at the top of my feed to be a strong match for my experience on my resume, but also to be new and verified as active."
*   **User Story:** "As a candidate, I appreciate it when the system learns my current interests (e.g., I'm saving a lot of 'Product Manager' roles) and shows me more of those, as long as they are still a good fit for my resume."
*   **User Story:** "As a candidate, I prefer to see a highly curated list of the best job matches each day, rather than being overwhelmed by too many options."

---

#### **Epic 3: Presentation & User Trust**

**Phase 3 Goal: Present jobs to the user in an intuitive, transparent, and trustworthy manner, reinforcing the engine's intelligence and building user confidence.**

**Feature 3.1: Explainable AI & Recommendation Insights**

*   **Objective:** Build user trust by making the "black box" of AI explainable, showing users *why* they are seeing a particular job.
*   **Requirements:**
    *   **REQ-3.1.1: "Why You're a Match" Snippet:** For each job card in the feed, display a concise, dynamically generated snippet explaining the recommendation. Examples:
        *   "Strong match for your experience with **Python** and **Django**."
        *   "Similar to your previous role at **[Company Name]**."
        *   "Based on your skill in **React** and interest in **FinTech**."
    *   **REQ-3.1.2: Detailed Match Breakdown:** Allow users to click for a more detailed view that highlights which parts of their resume (specific roles, skills, or projects) matched the job description.
*   **User Story:** "As a candidate, I want to understand why a job is being recommended to me, as it helps me trust the system and better evaluate the opportunity."

**Feature 3.2: A Curated and Dynamic Feed UI**

*   **Objective:** Redesign the job feed to present the curated list of 15 daily jobs in a way that feels focused, manageable, and insightful.
*   **Requirements:**
    *   **REQ-3.2.1: Top 15 Daily Jobs View:** The primary view of the job feed will prominently feature the "Top 15 Matches for Today."
    *   **REQ-3.2.2: Dynamic Thematic Grouping:** Within the feed, group jobs into intuitive, themed carousels to improve discoverability. Examples:
        *   "Your Top 5 AI Matches"
        *   "Newly Posted & Verified Active"
        *   "Remote Roles Matching Your Skills"
    *   **REQ-3.2.3: "Load More" Functionality:** After the top 15, provide a clear option for the user to "load more" or "explore other jobs," which would then show the next tier of relevant positions. This preserves the feeling of curation while still allowing for deeper exploration.
*   **User Story:** "As a candidate, I love seeing a short, focused list of top jobs for me each day. It makes my search feel manageable and less overwhelming."

### 5. Success Metrics

We will measure the success of the Hyper-Relevance Job Feed Engine through the following key metrics:

*   **User Engagement:**
    *   **Application Click-Through Rate (CTR):** Increase the percentage of users who click "Apply" on a recommended job by **25%**.
    *   **Job Save Rate:** Increase the number of jobs saved per user session by **30%**.
    *   **Job Hide Rate:** Decrease the number of jobs hidden per user session by **40%**, indicating higher relevance.
*   **User Trust & Data Quality:**
    *   **Stale Job Encounter Rate:** Reduce the number of user-reported stale jobs to near-zero. This will be measured via user feedback and internal monitoring from the "Job Liveness" service.
*   **Retention & Satisfaction:**
    *   **7-Day & 30-Day Retention:** Increase the percentage of users who return to the platform within 7 and 30 days by **20%**.
    *   **User Satisfaction Score (NPS/CSAT):** Improve user-reported satisfaction with the quality of job recommendations.

### 6. Out of Scope (For This Version)

*   **A/B Testing Framework for Ranking:** A dedicated framework for testing different ranking model weights will be developed as a fast-follow, not in the initial release.
*   **Real-time Push Notifications:** Proactively notifying users of a new top-match job via email or push notification is not part of this initial scope.
*   **Full-Text Search of All Jobs:** This PRD focuses on the curated, recommended feed. A broader "search all jobs" function is a separate feature.