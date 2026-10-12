# AGENTS.md - Development Guidelines for Recrutas

This document provides comprehensive guidelines for agentic coding agents working on the Recrutas codebase. Start with docs/ONBOARDING.md for the repo map, the feed flow and production runbook.

## Project Overview

Recrutas is a modern full-stack AI-powered recruitment platform with:
- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS + shadcn/ui
- **Backend**: Node.js + Express + TypeScript + Drizzle ORM
- **Database**: PostgreSQL 17 + pgvector, self-hosted on the Hetzner VPS behind pgBouncer (Supabase is used only for sign-in and resume files)
- **AI Integration**: resume parsing through a free-provider rotation (Groq → Gemini → OpenRouter → Cloudflare, then a rules parser) in `server/lib/ai-client.ts`; matching uses local embeddings + `server/job-scorer.ts`
- **Real-time**: WebSockets for live notifications

## Build, Test, and Quality Commands

### Development Commands
```bash
npm run dev                 # Start frontend only (Vite dev server)
npm run dev:server         # Start backend only (Express with tsx)
npm run dev:all            # Start both frontend and backend
npm run dev:server:start   # Start backend server
npm run dev:server:stop    # Stop backend server
```

### Build Commands
```bash
npm run build              # Full production build
npm run build:server       # Build backend with esbuild
npm run build:api          # Generate API handlers for Vercel
npm run start              # Start production server
```

### Testing Commands (CRITICAL: Always run after changes)
```bash
npm run test               # Run main test suite
npm run test:unit:backend  # Backend unit tests (Jest)
npm run test:integration:backend # Backend integration tests
npm run test:frontend      # Frontend tests (Vitest)
npm run test:e2e           # End-to-end tests
npm run test:playwright    # Playwright tests
npm run test:coverage      # Test coverage report
npm run test:all           # Run all test suites
```

### Single Test Execution
```bash
# Backend single test
npx jest path/to/test.test.ts

# Frontend single test  
npx vitest run path/to/test.test.ts

# E2E single test
npx playwright test path/to/spec.ts
```

### Code Quality Commands
```bash
npm run type-check         # TypeScript type checking (ALWAYS run)
npm run check              # Run type-check + lint
npm run lint               # ESLint; CI fails on errors
```

### Database Commands
Schema changes ship as idempotent SQL in `migrations/`, applied by hand on the VPS database with `psql`, and mirrored in `shared/schema.ts`. Do not run `npm run db:push` against production.

## Code Style Guidelines

### TypeScript Configuration
- **Strict Mode**: Currently disabled, but write as if strict mode is enabled
- **Path Aliases**: Use `@/` for client imports, `@shared/` for shared code
- **Target**: ES2022, Module: ESNext
- **Always provide explicit return types** for public functions

### Import Organization
```typescript
// 1. React imports
import React, { useState, useEffect } from 'react';

// 2. Third-party libraries
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';

// 3. Internal imports (with path aliases)
import { useAuth } from '@/hooks/use-auth';
import { apiClient } from '@/lib/api';
import { User } from '@/types/user';
import { JobSchema } from '@shared/schema';
```

### Component Guidelines

#### File Structure
```
components/
├── ui/                    # shadcn/ui components (don't modify unless necessary)
└── feature-components/
    ├── job-card/
    │   ├── job-card.tsx      # Main component
    │   ├── job-card.test.tsx # Tests
    │   └── index.ts          # Barrel export
```

#### Component Best Practices
- Use function components with TypeScript interfaces for props
- Follow React 18 patterns (forwardRef, useId for accessibility)
- Use compound component pattern for complex UIs
- Leverage shadcn/ui components and extend them
- Use Framer Motion for animations sparingly

```typescript
interface JobCardProps {
  job: Job;
  onApply?: (jobId: number) => void;
  className?: string;
}

export function JobCard({ job, onApply, className }: JobCardProps) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{job.title}</CardTitle>
      </CardHeader>
      {/* ... */}
    </Card>
  );
}
```

### Backend Guidelines

#### Service Layer Architecture
```typescript
// services/job.service.ts
export class JobService {
  async createJob(data: CreateJobDto): Promise<Job> {
    // Business logic here
  }
  
  async findJobs(filters: JobFilters): Promise<Job[]> {
    // Database queries via Drizzle ORM
  }
}
```

#### API Routes
```typescript
// routes.ts
import { JobService } from './services/job.service';

const jobService = new JobService();

app.post('/api/jobs', validateBody(CreateJobSchema), async (req, res) => {
  try {
    const job = await jobService.createJob(req.body);
    res.json(job);
  } catch (error) {
    handleError(error, res);
  }
});
```

#### Error Handling
```typescript
// middleware/error.middleware.ts
export function handleError(error: unknown, res: Response) {
  if (error instanceof ValidationError) {
    return res.status(400).json({ error: error.message });
  }
  // ... other error types
}
```

### Database Patterns

#### Drizzle ORM Usage
```typescript
import { db } from './lib/db';
import { jobs, users } from '../shared/schema';
import { eq, and } from 'drizzle-orm';

export async function findUserJobs(userId: number) {
  return await db
    .select()
    .from(jobs)
    .innerJoin(users, eq(jobs.userId, users.id))
    .where(eq(jobs.userId, userId));
}
```

#### Schema Definitions (shared/)
```typescript
// shared/schema.ts
export const jobs = pgTable('jobs', {
  id: serial().primaryKey(),
  title: text().notNull(),
  description: text(),
  createdAt: timestamp().defaultNow(),
});

export const JobSchema = createSelectSchema(jobs);
export const CreateJobSchema = createInsertSchema(jobs).pick({
  title: true,
  description: true,
});
```

### Frontend State Management

#### TanStack Query Patterns
```typescript
// hooks/use-jobs.ts
export function useJobs(filters?: JobFilters) {
  return useQuery({
    queryKey: ['jobs', filters],
    queryFn: () => apiClient.getJobs(filters),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useCreateJob() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: CreateJobDto) => apiClient.createJob(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}
```

#### Form Handling (React Hook Form + Zod)
```typescript
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CreateJobSchema } from '@shared/schema';

export function JobForm() {
  const form = useForm({
    resolver: zodResolver(CreateJobSchema),
    defaultValues: {
      title: '',
      description: '',
    },
  });
  
  // ...
}
```

### File Naming Conventions

#### Components
- PascalCase: `JobCard.tsx`, `UserProfile.tsx`
- Test files: `JobCard.test.tsx`
- Stories: `JobCard.stories.tsx` (if using Storybook)

#### Utilities/Services
- camelCase: `apiClient.ts`, `jobService.ts`
- Types: `user.ts`, `job.ts` (or `types/user.ts`)

#### Routes
- kebab-case URLs: `/api/jobs`, `/api/users/:id`

### Environment Variables

#### Required for Development
```bash
# Database (the VPS Postgres; see .env.example)
DATABASE_URL=postgresql://...

# Supabase (sign-in + resume files only)
VITE_SUPABASE_URL=https://...
VITE_SUPABASE_ANON_KEY=...
SUPABASE_URL=https://...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_JWT_SECRET=...   # the API verifies sign-in tokens with it
```

#### Optional Services
```bash
# AI Services (free tiers in rotation)
GROQ_API_KEY=...
OPENROUTER_API_KEY=...

# Email (Resend)
RESEND_API_KEY=...

# Payments
STRIPE_SECRET_KEY=sk_test_
STRIPE_PUBLISHABLE_KEY=pk_test_
```

### Testing Guidelines

#### Unit Tests
```typescript
import { render, screen } from '@testing-library/react';
import { JobCard } from './job-card';

describe('JobCard', () => {
  it('renders job title', () => {
    const job = { id: 1, title: 'Software Engineer' };
    render(<JobCard job={job} />);
    expect(screen.getByText('Software Engineer')).toBeInTheDocument();
  });
});
```

#### Integration Tests
```typescript
import request from 'supertest';
import { app } from '../index';

describe('Jobs API', () => {
  it('creates a new job', async () => {
    const response = await request(app)
      .post('/api/jobs')
      .send({ title: 'Developer', description: '...' })
      .expect(201);
      
    expect(response.body.title).toBe('Developer');
  });
});
```

## Quality Assurance Checklist

### Before Marking Task Complete
1. **Run `npm run type-check`** - No TypeScript errors
2. **Run relevant tests** - Single test execution preferred
3. **Verify imports** - Correct path aliases, no unused imports
4. **Check error handling** - Proper try-catch, validation
5. **Database operations** - Use Drizzle ORM, handle transactions
6. **API consistency** - Follow existing response patterns
7. **UI consistency** - Use shadcn/ui components, follow design system

### Common Patterns to Follow
- Use TanStack Query for server state, React state for UI state
- Implement proper loading and error states
- Use Zod for validation throughout the stack
- Leverage shared schema types between frontend/backend
- Use WebSockets for real-time features
- Implement proper auth middleware on protected routes
- Follow the Recrutas principles in docs/ONBOARDING.md: direct-from-company only, US only, real links, truthful (never guessed), frugal, easy on the server

### Security Considerations
- Never log or expose sensitive data (API keys, passwords)
- Validate all input with Zod schemas
- Use Supabase Auth for authentication
- Implement proper CORS configuration
- Sanitize user-generated content

## Architecture Notes

### Service Boundaries
- **Frontend**: UI, forms, client-side validation, real-time UI updates
- **Backend**: Business logic, database operations, external API calls
- **Shared**: Schema definitions, types, validation rules

### Communication Patterns
- REST APIs for CRUD operations
- WebSockets for real-time notifications
- Background jobs for AI processing (resume parsing, job matching)

### Database Design
- Ship schema changes as idempotent SQL in `migrations/` (applied by hand)
- Keep shared schema in sync with database
- Use foreign keys and constraints for data integrity
- Index frequently queried columns

This document should be updated as the codebase evolves. Always ensure your changes align with these guidelines and maintain the high quality standards of the Recrutas platform.