/**
 * Which engine reads a PDF résumé, and in what order.
 *
 * Written after every upload for 45 days (10/10) fell back to the rule engine:
 * the multimodal chain ran first and spent each upload on two dead providers
 * (OpenRouter's retired model, Gemini's 20-requests/day free tier), and the
 * text fallback called a Groq model that had been retired. Text-based PDFs now
 * go to the text model first; multimodal is for scanned PDFs and second chances.
 */
import { readFileSync } from 'fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { groqCreate, callAIWithPDF } = vi.hoisted(() => ({
  groqCreate: vi.fn(),
  callAIWithPDF: vi.fn(),
}));

vi.mock('groq-sdk', () => ({
  default: class { chat = { completions: { create: groqCreate } }; },
}));
vi.mock('../server/lib/ai-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/lib/ai-client')>()),
  callAIWithPDF,
  isAIAvailable: () => true,
}));

process.env.GROQ_API_KEY = 'test-key';
delete process.env.GROQ_MODEL;
// Later fallbacks in the text chain; with real keys they'd make network calls.
delete process.env.HF_API_KEY;
delete process.env.USE_OLLAMA;

// Fresh module per test: the Groq limiter's token bucket is module state, and
// a few parses in a row would otherwise make later tests wait for it to refill.
async function loadParser() {
  vi.resetModules();
  return (await import('../server/ai-resume-parser')).AIResumeParser;
}

const PDF = readFileSync('Resume-Sample-1-Software-Engineer.pdf');
const EXTRACTED = {
  personalInfo: { name: 'First Last' },
  summary: '',
  skills: { technical: ['React', 'Node.js'], soft: [], tools: ['Docker'] },
  experience: { totalYears: 5, level: 'mid', positions: [{ title: 'Programmer Analyst', company: 'Walmart', duration: '2011-2016' }] },
  education: [], certifications: [], projects: [], languages: [],
};
const groqAnswers = (data: unknown) =>
  groqCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(data) } }] });

beforeEach(() => {
  groqCreate.mockReset();
  callAIWithPDF.mockReset();
});

describe('PDF résumé parse order', () => {
  it('reads a text-based PDF with the text model and never spends a multimodal call', async () => {
    groqAnswers(EXTRACTED);
    const r = await new (await loadParser())().parseFile(PDF, 'application/pdf');

    expect(r.extractor).toBe('ai-text');
    expect(r.degraded).toBe(false);
    expect(r.aiExtracted.experience.positions[0].title).toBe('Programmer Analyst');
    expect(callAIWithPDF).not.toHaveBeenCalled();
  });

  it('asks Groq for a live model at low reasoning effort', async () => {
    groqAnswers(EXTRACTED);
    await new (await loadParser())().parseFile(PDF, 'application/pdf');

    const body = groqCreate.mock.calls[0][0];
    expect(body.model).toBe('openai/gpt-oss-20b');
    expect(body.reasoning_effort).toBe('low');
  });

  it('asks Groq again when its first answer is empty', async () => {
    const empty = { ...EXTRACTED, skills: { technical: [], soft: [], tools: [] }, experience: { totalYears: 0, level: 'entry', positions: [] } };
    groqCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(empty) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(EXTRACTED) } }] });
    const r = await new (await loadParser())().parseFile(PDF, 'application/pdf');

    expect(groqCreate).toHaveBeenCalledTimes(2);
    expect(r.extractor).toBe('ai-text');
    expect(callAIWithPDF).not.toHaveBeenCalled();
  });

  it('gives multimodal a second chance when the text model fails', async () => {
    groqCreate.mockRejectedValue(Object.assign(new Error('model_not_found'), { status: 404 }));
    callAIWithPDF.mockResolvedValue(JSON.stringify(EXTRACTED));
    const r = await new (await loadParser())().parseFile(PDF, 'application/pdf');

    expect(callAIWithPDF).toHaveBeenCalledTimes(1);
    expect(r.extractor).toBe('gemini-multimodal');
    expect(r.degraded).toBe(false);
  });

  it('keeps the rule engine result, flagged with both reasons, when both AI engines fail', async () => {
    groqCreate.mockRejectedValue(new Error('groq down'));
    callAIWithPDF.mockRejectedValue(new Error('gemini quota'));
    const r = await new (await loadParser())().parseFile(PDF, 'application/pdf');

    expect(r.extractor).toBe('rules');
    expect(r.degraded).toBe(true);
    expect(r.primaryError).toMatch(/text: .*groq down/);
    expect(r.primaryError).toMatch(/pdf: gemini quota/);
  });

  it('sends a scanned PDF (no text layer) to multimodal first', async () => {
    const Parser = await loadParser();
    vi.spyOn(Parser.prototype as any, 'pdfTextLayer').mockResolvedValueOnce('');
    callAIWithPDF.mockResolvedValue(JSON.stringify(EXTRACTED));
    const r = await new Parser().parseFile(PDF, 'application/pdf');

    expect(callAIWithPDF).toHaveBeenCalledTimes(1);
    expect(groqCreate).not.toHaveBeenCalled();
    expect(r.extractor).toBe('gemini-multimodal');
  });
});
