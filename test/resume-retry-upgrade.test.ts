/**
 * Re-parsing a résumé whose last parse came from the rule engine.
 *
 * The retry job now also picks these up (every upload during the AI outage
 * landed here). Unlike a repair of a failed parse, the profile is live and may
 * have been edited, so an upgrade must (a) never rewrite it with another rule
 * result and (b) keep the skills it already has.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/services/candidate-embedding.service', () => ({ invalidateCandidateEmbedding: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../server/inngest-service.js', () => ({ sendInngestEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../server/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../server/error-monitoring', () => ({ captureException: vi.fn() }));

import { ResumeService, sniffResumeMime } from '../server/services/resume.service';

const aiParse = (skills: string[], extractor = 'ai-text') => ({
  text: 'resume text',
  extractor,
  degraded: extractor === 'rules',
  confidence: 80,
  aiExtracted: {
    skills: { technical: skills, soft: [], tools: [] },
    experience: { level: 'mid', positions: [{ title: 'Cybersecurity Intern', company: 'Acme', duration: '2024' }] },
    personalInfo: {},
    education: [],
  },
});

function setup(existing: Record<string, unknown>, parse: unknown) {
  const storage: any = {
    getCandidateUser: vi.fn().mockResolvedValue(existing),
    incrementParseAttempts: vi.fn().mockResolvedValue(undefined),
    refundParseAttempt: vi.fn().mockResolvedValue(undefined),
    getResumeSignedUrl: vi.fn().mockResolvedValue('https://storage.example/resume.pdf'),
    upsertCandidateUser: vi.fn().mockResolvedValue(undefined),
  };
  const parser: any = { parseFile: vi.fn().mockResolvedValue(parse) };
  return { storage, service: new ResumeService(storage, parser) };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70]))));
});

describe('retryFailedParse on a degraded (completed) profile', () => {
  it('leaves the profile alone when the retry is still the rule engine', async () => {
    const { storage, service } = setup(
      { resumeProcessingStatus: 'completed', skills: ['Python'] },
      aiParse(['Python'], 'rules'),
    );
    const r = await service.retryFailedParse('u1', 'u1/resume.pdf');

    expect(r.success).toBe(false);
    expect(storage.upsertCandidateUser).not.toHaveBeenCalled();
    expect(storage.incrementParseAttempts).toHaveBeenCalled(); // so it stops after 3 tries
  });

  it('gives the attempt back when the AI was only out of quota', async () => {
    // The job runs hourly; a busy afternoon must not use up all 3 tries.
    const { storage, service } = setup(
      { resumeProcessingStatus: 'completed', skills: ['Python'] },
      { ...aiParse(['Python'], 'rules'), primaryError: 'groq: Groq API error 429: Rate limit reached for tokens per day (TPD)' },
    );
    await service.retryFailedParse('u1', 'u1/resume.pdf');
    expect(storage.incrementParseAttempts).toHaveBeenCalled();
    expect(storage.refundParseAttempt).toHaveBeenCalledWith('u1');
  });

  it('still counts the attempt for errors that do not clear on their own', async () => {
    const { storage, service } = setup(
      { resumeProcessingStatus: 'completed', skills: ['Python'] },
      { ...aiParse(['Python'], 'rules'), primaryError: 'gemini: HTTP 404 model not found' },
    );
    await service.retryFailedParse('u1', 'u1/resume.pdf');
    expect(storage.refundParseAttempt).not.toHaveBeenCalled();
  });

  it('writes an AI result, keeping the skills the profile already had', async () => {
    const { storage, service } = setup(
      { resumeProcessingStatus: 'completed', skills: ['Python', 'Customer Service'] },
      aiParse(['React', 'Python']),
    );
    const r = await service.retryFailedParse('u1', 'u1/resume.pdf');

    expect(r.success).toBe(true);
    const update = storage.upsertCandidateUser.mock.calls[0][0];
    expect(update.skills).toEqual(expect.arrayContaining(['React', 'Python', 'Customer Service']));
    expect(update.skills.filter((s: string) => s === 'Python')).toHaveLength(1);
    expect(update.resumeParsingData.positions[0].title).toBe('Cybersecurity Intern');
    expect(update.resumeParsingData.extractor).toBe('ai-text');
    expect(update.resumeParsingData.parsedWithModel).toBe('openai/gpt-oss-20b');
  });

  it('still replaces skills when repairing a failed parse', async () => {
    const { storage, service } = setup(
      { resumeProcessingStatus: 'failed', skills: ['Stale Skill'] },
      aiParse(['React']),
    );
    await service.retryFailedParse('u1', 'u1/resume.pdf');

    expect(storage.upsertCandidateUser.mock.calls[0][0].skills).toEqual(['React']);
  });
});

describe('sniffResumeMime', () => {
  it('reads the type from the bytes — storage paths have no extension', () => {
    expect(sniffResumeMime(Buffer.from('%PDF-1.7'), 'u/resume-123')).toBe('application/pdf');
    expect(sniffResumeMime(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'u/resume-123'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });
});

describe('an upgrade that extracts nothing', () => {
  it('does not overwrite the profile with an empty AI result', async () => {
    const empty = { ...aiParse([]), aiExtracted: { skills: { technical: [], soft: [], tools: [] }, experience: { positions: [] }, personalInfo: {}, education: [] } };
    const { storage, service } = setup({ resumeProcessingStatus: 'completed', skills: ['Python'] }, empty);
    const r = await service.retryFailedParse('u1', 'u1/resume-123');

    expect(r.success).toBe(false);
    expect(storage.upsertCandidateUser).not.toHaveBeenCalled();
  });

  it('parses a Word file stored without an extension as Word', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))));
    const { service } = setup({ resumeProcessingStatus: 'completed', skills: [] }, aiParse(['React']));
    await service.retryFailedParse('u1', 'u1/resume-123');
    const parser = (service as any).aiResumeParser;
    expect(parser.parseFile.mock.calls[0][1]).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });
});
