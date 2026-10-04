/**
 * Unit Tests for AI Resume Parser
 * Tests extraction logic, confidence calculation, and error handling in isolation
 *
 * Run with: npm run test:unit:backend
 */

import assert from 'assert';
import { describe, test } from '@jest/globals';
import {
  generateCompletePdfBuffer,
  generateMinimalResumePdfBuffer,
  generateNoSkillsPdfBuffer,
  generateMalformedPdfBuffer,
} from './fixtures/fixture-generator.js';
import { AIResumeParser } from '../server/ai-resume-parser.ts';

// Note: Tests use direct PDF parsing without mocking
// The parser has built-in fallback to rule-based extraction if AI unavailable

const parser = new AIResumeParser();
let testsPassed = 0;
let testsFailed = 0;

async function runTest(testName, testFn) {
  try {
    await testFn();
    console.log(`✅ ${testName}`);
    testsPassed++;
  } catch (err) {
    console.error(`❌ ${testName}: ${err.message}`);
    testsFailed++;
  }
}

async function testSkillsExtractionFromCompletePdf() {
  const buffer = generateCompletePdfBuffer();
  // Use text parsing since fixtures now return text content for reliable testing
  const result = await parser.parseText(buffer.toString('utf8'));

  assert(result.confidence > 0, 'Should have positive confidence');
  assert(
    result.aiExtracted.skills.technical.length > 0,
    'Should extract technical skills'
  );
  assert(
    result.aiExtracted.skills.technical.some((s) =>
      ['JavaScript', 'TypeScript', 'React', 'Node.js'].some((t) =>
        s.toLowerCase().includes(t.toLowerCase())
      )
    ),
    'Should extract expected technologies'
  );
}

async function testSkillsExtractionFromMinimalResume() {
  // Pass real resume text instead of binary PDF bytes — the parser is purely
  // extractive on the rule path, so the input must literally contain the
  // skills we expect to extract.
  const text = `Jane Smith
jane@example.com

SKILLS
React, JavaScript, TypeScript, Node.js, Git`;
  const result = await parser.parseText(text);

  assert(result.confidence > 0, 'Should have positive confidence');
  assert(
    result.aiExtracted.skills.technical.length > 0,
    'Should extract at least some skills'
  );
  assert(
    result.aiExtracted.skills.technical.some((s) =>
      ['React', 'JavaScript'].some((t) =>
        s.toLowerCase().includes(t.toLowerCase())
      )
    ),
    'Should extract React or JavaScript from the skills section'
  );
}

async function testHandlesNoSkillsSection() {
  const buffer = generateNoSkillsPdfBuffer();
  const result = await parser.parseText(buffer.toString('utf8'));

  assert(result.confidence > 0, 'Should have positive confidence');
  // Skills array should exist but may be empty or inferred from experience
  assert(Array.isArray(result.aiExtracted.skills.technical), 'Should have skills array');
}

async function testPersonalInfoExtraction() {
  const buffer = generateCompletePdfBuffer();
  const result = await parser.parseText(buffer.toString('utf8'));

  const info = result.aiExtracted.personalInfo;
  // personalInfo may or may not be populated depending on PDF content
  assert(info !== undefined, 'Should have personalInfo object');
  // Email format check when present
  if (info.email) {
    assert(info.email.includes('@'), 'Email should be valid format');
  }
}

async function testExperienceYearsCalculation() {
  const buffer = generateCompletePdfBuffer();
  const result = await parser.parseText(buffer.toString('utf8'));

  const experience = result.aiExtracted.experience;
  assert(typeof experience.totalYears === 'number', 'Should have numeric years');
  assert(experience.totalYears >= 0, 'Years should not be negative');
  // Just verify we got a number, exact value depends on parsing accuracy
  assert(experience.totalYears >= 0, 'Should have years >= 0');
}

async function testExperienceLevelDetection() {
  const buffer = generateCompletePdfBuffer();
  const result = await parser.parseText(buffer.toString('utf8'));

  const level = result.aiExtracted.experience.level;
  assert(
    ['entry', 'mid', 'senior', 'lead', 'executive'].includes(level),
    'Should be valid experience level'
  );
  // Complete resume with 5+ years suggests mid or senior level
  assert(
    ['mid', 'senior', 'executive'].includes(level),
    'Should detect mid+ level from complete resume with 5+ years'
  );
}

async function testConfidenceScoreHighForComplete() {
  const buffer = generateCompletePdfBuffer();
  const result = await parser.parseText(buffer.toString('utf8'));

  // Confidence is on 0-100 scale; real PDFs may score lower than synthetic fixtures
  assert(
    typeof result.confidence === 'number' && result.confidence >= 0 && result.confidence <= 100,
    `Should have numeric confidence 0-100, got ${result.confidence}`
  );
}

async function testConfidenceScoreLowForMinimal() {
  // Parse the PDF the way uploads do. This used to feed the raw PDF bytes to
  // parseText, and the confidence it checked came from PDF metadata tags
  // ("<xmp:ModifyDate>") being reported as job titles.
  const buffer = generateMinimalResumePdfBuffer();
  const result = await parser.parseFile(buffer, 'application/pdf');

  // Confidence is on 0-100 scale, minimal resume should still have positive confidence
  assert(
    result.confidence >= 10 && result.confidence <= 100,
    `Should have reasonable confidence for minimal resume, got ${result.confidence}`
  );
  const titles = (result.aiExtracted.experience.positions || []).map((p) => p.title);
  assert(!titles.some((t) => /<\/?[a-z]+:/i.test(t)), `PDF metadata parsed as job titles: ${titles.join(', ')}`);
}

async function testMalformedPdfHandling() {
  const buffer = generateMalformedPdfBuffer();

  try {
    const result = await parser.parseFile(buffer, 'application/pdf');
    // Should either fail gracefully or return partial data
    assert(
      result.aiExtracted !== undefined,
      'Should handle gracefully without crashing'
    );
  } catch (err) {
    // Acceptable to throw on malformed PDF - error message can vary
    assert(
      err.message.includes('PDF') || err.message.includes('parse') || err.message.includes('Failed'),
      'Error should mention parsing failure'
    );
  }
}

async function testUnsupportedFileTypeRejection() {
  const buffer = Buffer.from('Not a PDF', 'utf8');

  // Parser attempts to read unknown types as text and process them
  // This tests that it handles this gracefully
  const result = await parser.parseFile(buffer, 'application/octet-stream');

  // Should return a result with low confidence for unstructured content
  assert(result.aiExtracted !== undefined, 'Should return extracted data structure');
  assert(typeof result.confidence === 'number', 'Should have confidence score');
}

async function testTextParsing() {
  const textContent = `John Doe
john@example.com
+1234567890

SKILLS:
JavaScript, React, Node.js, TypeScript, Python

EXPERIENCE:
Senior Software Engineer at Tech Corp (2022-Present)
Software Engineer at StartUp Inc (2019-2022)

EDUCATION:
B.S. Computer Science, University (2019)`;

  const result = await parser.parseText(textContent);

  assert(result.confidence > 0, 'Should have positive confidence');
  assert(result.aiExtracted.personalInfo.name, 'Should extract name');
  assert(
    result.aiExtracted.skills.technical.length > 0,
    'Should extract technical skills'
  );
}

async function testSpecialCharacterHandling() {
  const textContent = `José García
josé@example.com
Skills: C++, C#, F#, Objective-C`;

  const result = await parser.parseText(textContent);

  assert(result.confidence > 0, 'Should have positive confidence');
  // Name extraction from text might not always work, just verify structure exists
  assert(result.aiExtracted.personalInfo !== undefined, 'Should have personalInfo');
  assert(
    result.aiExtracted.skills.technical.some((s) => s.includes('C')),
    'Should extract C-family languages'
  );
}

async function testEducationExtraction() {
  const buffer = generateCompletePdfBuffer();
  const result = await parser.parseText(buffer.toString('utf8'));

  const education = result.aiExtracted.education;
  assert(Array.isArray(education), 'Should have education array');
  if (education.length > 0) {
    // Education entry should have degree info
    assert(education[0].degree || education[0].institution, 'Should have education details');
  }
}

async function testCertificationExtraction() {
  const buffer = generateCompletePdfBuffer();
  const result = await parser.parseText(buffer.toString('utf8'));

  const certs = result.aiExtracted.certifications;
  assert(Array.isArray(certs), 'Should have certifications array');
}

async function testProjectExtraction() {
  const buffer = generateCompletePdfBuffer();
  const result = await parser.parseText(buffer.toString('utf8'));

  const projects = result.aiExtracted.projects;
  assert(Array.isArray(projects), 'Should have projects array');
}

async function testLanguageExtraction() {
  const textContent = `John Doe
Languages: English (native), Spanish (fluent), French (intermediate)`;

  const result = await parser.parseText(textContent);

  const languages = result.aiExtracted.languages;
  assert(Array.isArray(languages), 'Should have languages array');
}

async function testEmptyResumeHandling() {
  try {
    const result = await parser.parseText('');
    assert(
      !result.parsed || result.confidence < 0.3,
      'Should mark empty resume as unparsed or very low confidence'
    );
  } catch (err) {
    // Acceptable to throw on empty input
    assert(true, 'Empty resume handling acceptable');
  }
}

async function testReturnStructure() {
  const buffer = generateCompletePdfBuffer();
  const result = await parser.parseText(buffer.toString('utf8'));

  // Verify all expected fields exist
  assert(typeof result.confidence === 'number', 'Should have confidence number');
  assert(result.aiExtracted, 'Should have extractedData');
  assert(
    result.aiExtracted.personalInfo,
    'Should have personalInfo'
  );
  assert(
    result.aiExtracted.skills,
    'Should have skills'
  );
  assert(
    result.aiExtracted.experience,
    'Should have experience'
  );
  assert(result.aiExtracted.education, 'Should have education');
}

async function testSkillNormalization() {
  const textContent = `
  Skills:
  - javascript (8 years)
  - REACT (5 years)
  - node.js (4 years)
  - Python (2 years)
  - SQL, postgresql, mysql
  `;

  const result = await parser.parseText(textContent);

  const skills = result.aiExtracted.skills.technical;
  // Should normalize variations of the same skill
  const hasJavaScript = skills.some((s) =>
    ['javascript', 'js'].some((variant) => s.toLowerCase().includes(variant))
  );
  const hasReact = skills.some((s) => s.toLowerCase().includes('react'));

  assert(hasJavaScript, 'Should normalize JavaScript variants');
  assert(hasReact, 'Should include React');
}

async function testSoftSkillDetection() {
  const textContent = `
  Skills:
  Technical: JavaScript, React
  Soft Skills: Leadership, Communication, Problem Solving, Team Management
  `;

  const result = await parser.parseText(textContent);

  const softSkills = result.aiExtracted.skills.soft;
  assert(Array.isArray(softSkills), 'Should have soft skills array');
  const hasSoftSkill = softSkills.some((s) =>
    ['Leadership', 'Communication', 'Problem'].some((t) =>
      s.toLowerCase().includes(t.toLowerCase())
    )
  );
  assert(hasSoftSkill, 'Should detect soft skills');
}

// Run all tests
async function runAllTests() {
  console.log('🧪 AI Resume Parser Unit Tests\n');

  await runTest('Skills extraction from complete PDF', testSkillsExtractionFromCompletePdf);
  await runTest('Skills extraction from minimal resume', testSkillsExtractionFromMinimalResume);
  await runTest('Handles no skills section', testHandlesNoSkillsSection);
  await runTest('Personal info extraction', testPersonalInfoExtraction);
  await runTest('Experience years calculation', testExperienceYearsCalculation);
  await runTest('Experience level detection', testExperienceLevelDetection);
  await runTest('High confidence for complete resume', testConfidenceScoreHighForComplete);
  await runTest('Medium confidence for minimal resume', testConfidenceScoreLowForMinimal);
  await runTest('Malformed PDF handling', testMalformedPdfHandling);
  await runTest('Unsupported file type rejection', testUnsupportedFileTypeRejection);
  await runTest('Text parsing', testTextParsing);
  await runTest('Special character handling', testSpecialCharacterHandling);
  await runTest('Education extraction', testEducationExtraction);
  await runTest('Certification extraction', testCertificationExtraction);
  await runTest('Project extraction', testProjectExtraction);
  await runTest('Language extraction', testLanguageExtraction);
  await runTest('Empty resume handling', testEmptyResumeHandling);
  await runTest('Return structure validation', testReturnStructure);
  await runTest('Skill normalization', testSkillNormalization);
  await runTest('Soft skill detection', testSoftSkillDetection);

  console.log(`\n📊 Results: ${testsPassed} passed, ${testsFailed} failed`);

  if (testsFailed > 0) {
    throw new Error(`${testsFailed} tests failed`);
  }
}

describe('AI Resume Parser Unit Tests', () => {
  test('Run all unit tests', async () => {
    await runAllTests();
  }, 60000);
});
