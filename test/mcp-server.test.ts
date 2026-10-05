/**
 * The MCP connector, driven through the SDK's in-memory transport with the
 * database mocked: the tools a client sees, and what they return.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const executeMock = vi.fn();
vi.mock('../server/db', () => ({ db: { execute: (...a: unknown[]) => executeMock(...a) } }));
vi.mock('../server/storage', () => ({
  storage: {
    getJobRecommendations: vi.fn(async () => ({ jobs: [
      { id: 11, title: 'Support Engineer', company: 'PubMatic', location: 'Seattle, WA', workType: 'onsite', matchScore: 82, createdAt: new Date(Date.now() - 2 * 864e5), verdict: { label: 'apply', reasons: ['You meet the stated requirements'], toCheck: [] } },
      { id: 12, title: 'DRSN Technician', company: 'C3EL', location: 'Scott AFB, IL', matchScore: 67, createdAt: new Date(), verdict: { label: 'skip', reasons: ['Requires an active Top Secret clearance'], toCheck: [] } },
    ] })),
    getJobPosting: vi.fn(async (id: number) => (id === 11 ? { id: 11, title: 'Support Engineer', company: 'PubMatic', status: 'active', externalUrl: 'https://jobs.lever.co/pubmatic/x', description: '<li>3+ years of experience</li><li>Visa sponsorship is not available.</li>' } : undefined)),
    getApplicationsWithStatus: vi.fn(async () => []),
  },
}));
vi.mock('../server/services/application-diagnosis.service', () => ({
  diagnoseCandidate: vi.fn(async () => ({ enoughData: false, findings: [], nextStep: { text: 'After 3 applications, we\'ll show you what\'s working.' } })),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildRecrutasMcpServer } from '../server/mcp/recrutas-mcp';

let client: Client;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return r.content[0].text as string;
};

beforeAll(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildRecrutasMcpServer('user-1').connect(a);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
});

describe('Recrutas MCP server', () => {
  it('exposes the six tools, read-only except recording an application', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['get_job', 'list_my_applications', 'my_week', 'record_application', 'search_my_matches', 'why_no_replies']);
    expect(tools.find(t => t.name === 'search_my_matches')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find(t => t.name === 'record_application')?.annotations?.readOnlyHint).toBe(false);
  });

  it('lists matches with verdicts and filters by verdict', async () => {
    const all = await call('search_my_matches');
    expect(all).toContain('#11 Support Engineer · PubMatic');
    expect(all).toContain('APPLY: You meet the stated requirements');
    const skip = await call('search_my_matches', { verdict: 'skip' });
    expect(skip).toContain('1 matches with verdict "skip"');
    expect(skip).toContain('Requires an active Top Secret clearance');
    expect(skip).not.toContain('PubMatic');
  });

  it('returns job details with requirements and the apply link', async () => {
    executeMock.mockResolvedValue([]); // candidate facts + "already applied": none
    const job = await call('get_job', { job_id: 11 });
    expect(job).toContain('Stated requirements: No visa sponsorship; 3+ years of experience');
    expect(job).toContain('Apply: https://jobs.lever.co/pubmatic/x');
    expect(await call('get_job', { job_id: 999 })).toBe('No job #999.');
  });

  it('records an application once', async () => {
    executeMock.mockResolvedValueOnce([{ id: 1 }]);
    expect(await call('record_application', { job_id: 11 })).toMatch(/^Recorded: applied to Support Engineer at PubMatic/);
    executeMock.mockResolvedValueOnce([]);
    expect(await call('record_application', { job_id: 11 })).toMatch(/^Already recorded/);
  });

  it('rejects invalid input', async () => {
    const r: any = await client.callTool({ name: 'search_my_matches', arguments: { verdict: 'maybe' } });
    expect(r.isError).toBe(true);
  });
});
