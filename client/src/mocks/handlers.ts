/**
 * MSW (Mock Service Worker) Handlers for Testing
 *
 * WARNING: This file is for TESTING ONLY.
 * These handlers mock API responses for unit/integration tests.
 * They should NEVER be used in production builds.
 *
 * The handlers are only loaded via setupTests.ts during test runs.
 * Production code should use real API endpoints.
 */
import { http, HttpResponse } from 'msw';

// Mock data generators
const mockJobMatches = [
  {
    jobId: 1,
    job: {
      id: 1,
      title: 'Senior Frontend Engineer',
      company: 'Tech Corp',
      description: 'We are looking for a senior frontend engineer',
      location: 'Remote',
      workType: 'remote',
      skills: ['React', 'TypeScript', 'Node.js'],
      salaryMin: 120000,
      salaryMax: 160000,
      trustScore: 95,
      livenessStatus: 'active',
    },
    finalScore: 0.92,
    semanticRelevance: 0.95,
    recency: 0.9,
    liveness: 1.0,
    personalization: 0.85,
    skillMatches: ['React', 'TypeScript', 'Node.js'],
    aiExplanation: 'Excellent match: you have all required skills and relevant experience',
    isVerifiedActive: true,
    isDirectFromCompany: false,
  },
  {
    jobId: 2,
    job: {
      id: 2,
      title: 'Full Stack Engineer',
      company: 'StartUp Inc',
      description: 'Join our growing startup',
      location: 'San Francisco, CA',
      workType: 'hybrid',
      skills: ['JavaScript', 'React', 'Python'],
      salaryMin: 100000,
      salaryMax: 140000,
      trustScore: 75,
      livenessStatus: 'active',
    },
    finalScore: 0.82,
    semanticRelevance: 0.85,
    recency: 0.8,
    liveness: 0.8,
    personalization: 0.75,
    skillMatches: ['React', 'JavaScript'],
    aiExplanation: 'Good match: strong React skills, though Python experience is limited',
    isVerifiedActive: false,
    isDirectFromCompany: true,
  },
  {
    jobId: 3,
    job: {
      id: 3,
      title: 'React Developer',
      company: 'Web Solutions',
      description: 'React specialist needed',
      location: 'New York, NY',
      workType: 'onsite',
      skills: ['React', 'JavaScript', 'CSS'],
      salaryMin: 90000,
      salaryMax: 120000,
      trustScore: 60,
      livenessStatus: 'stale',
    },
    finalScore: 0.71,
    semanticRelevance: 0.9,
    recency: 0.6,
    liveness: 0.4,
    personalization: 0.7,
    skillMatches: ['React', 'JavaScript'],
    aiExplanation: 'Moderate match: skills align but job is older',
    isVerifiedActive: false,
    isDirectFromCompany: false,
  },
];

const mockSavedJobs: number[] = [1];
const mockAppliedJobs: number[] = [2];
const mockHiddenJobs: number[] = [];

export const handlers = [
  http.get('/api/candidate/profile', () => {
    return HttpResponse.json({
      name: 'John Doe',
      skills: ['React', 'TypeScript'],
      experience: '5 years',
    });
  }),

  http.get('/api/candidate/applications', () => {
    return HttpResponse.json([
      { id: 1, jobTitle: 'Frontend Developer', company: 'Tech Corp', status: 'Applied' },
      { id: 2, jobTitle: 'Backend Developer', company: 'Data Inc', status: 'Under Review' },
    ]);
  }),

  http.get('/api/candidate/recommendations', () => {
    return HttpResponse.json([
      { id: 1, title: 'Full Stack Developer', company: 'Innovate LLC' },
      { id: 2, title: 'React Native Developer', company: 'Mobile First' },
    ]);
  }),

  // AI Job Feed Handlers
  http.get('/api/ai-matches', ({ request }) => {
    const url = new URL(request.url);
    const searchTerm = url.searchParams.get('q');
    const location = url.searchParams.get('location');
    const workType = url.searchParams.get('workType');
    const company = url.searchParams.get('company');

    let matches = mockJobMatches;

    if (searchTerm) {
      matches = matches.filter((m) =>
        m.job.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        m.job.company.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    if (location) {
      matches = matches.filter(
        (m) => m.job.location.toLowerCase() === location.toLowerCase()
      );
    }

    if (workType) {
      matches = matches.filter(
        (m) => m.job.workType.toLowerCase() === workType.toLowerCase()
      );
    }

    if (company) {
      matches = matches.filter(
        (m) => m.job.company.toLowerCase().includes(company.toLowerCase())
      );
    }

    // Shape mirrors the real /api/ai-matches paginated response the feed reads.
    return HttpResponse.json({ jobs: matches, total: matches.length, page: 1, hasMore: false });
  }),

  http.get('/api/candidate/job-actions', () => {
    return HttpResponse.json({
      savedJobs: mockSavedJobs,
      appliedJobs: mockAppliedJobs,
      hiddenJobs: mockHiddenJobs,
    });
  }),

  http.post('/api/candidate/apply/:jobId', ({ params }) => {
    const jobId = parseInt(params.jobId as string);
    if (!mockAppliedJobs.includes(jobId)) {
      mockAppliedJobs.push(jobId);
    }
    return HttpResponse.json({ success: true, jobId });
  }),

  http.post('/api/candidate/saved-jobs', ({ request }) => {
    // Save job
    return HttpResponse.json({ success: true });
  }),

  http.delete('/api/candidate/saved-jobs/:jobId', ({ params }) => {
    const jobId = parseInt(params.jobId as string);
    const index = mockSavedJobs.indexOf(jobId);
    if (index > -1) {
      mockSavedJobs.splice(index, 1);
    }
    return HttpResponse.json({ success: true });
  }),

  http.post('/api/candidate/hidden-jobs', ({ request }) => {
    // Hide job
    return HttpResponse.json({ success: true });
  }),

  http.get('/api/talent-owner/jobs', () => {
    return HttpResponse.json([
      { id: 1, title: 'Software Engineer', company: 'My Company' },
    ]);
  }),

  http.post('/api/jobs', () => {
    return HttpResponse.json({ id: 2, title: 'New Job', company: 'My Company' });
  }),

  http.get('/api/candidates/stats', () => {
    return HttpResponse.json({
      newMatches: 5,
      profileViews: 10,
      activeChats: 2,
      applicationsPending: 3,
      applicationsRejected: 1,
      applicationsAccepted: 0,
    });
  }),

  http.get('/api/candidates/activity', () => {
    return HttpResponse.json([
      { id: 1, type: 'match', description: 'New match for React Developer', createdAt: new Date().toISOString() },
    ]);
  }),

  http.get('/api/recruiter/stats', () => {
    return HttpResponse.json({
      activeJobs: 2,
      totalMatches: 10,
      activeChats: 3,
      hires: 1,
    });
  }),

  http.get('/api/recruiter/candidates', () => {
    return HttpResponse.json([
      { id: 1, firstName: 'Jane', lastName: 'Doe', email: 'jane@doe.com', skills: ['Node.js'], experience: '3 years', matchScore: 80, status: 'screening', appliedAt: new Date().toISOString() },
    ]);
  }),
];
