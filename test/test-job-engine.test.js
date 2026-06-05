import assert from 'node:assert';
import supertest from 'supertest';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 5001; // Match server port
const API_URL = `http://localhost:${PORT}`;
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const api = supertest(API_URL);

async function createNewUserAndGetToken() {
  const email = `test-job-engine-user-${Date.now()}@example.com`;
  const password = 'password123';

  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {throw new Error(`Supabase sign-up failed: ${error.message}`);}
  
  if (!data.session) {
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {throw new Error(`Supabase sign-in failed: ${signInError.message}`);}
    if (!signInData.session) {throw new Error('Could not get a session.');}
    return { token: signInData.session.access_token, userId: signInData.user.id, email };
  }

  return { token: data.session.access_token, userId: data.user.id, email };
}

async function deleteUser(userId) {
    const adminAuthClient = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await adminAuthClient.auth.admin.deleteUser(userId);
    if(error) {
        console.error(`Failed to delete user ${userId}:`, error.message);
    }
}

export async function runJobEngineTests() {
  let token, userId, email;
  try {
    console.log('\n--- Running Job Engine Tests ---');
    console.log('Step 1: Creating a new user and getting token...');
    ({ token, userId, email } = await createNewUserAndGetToken());
    console.log(`User created with email: ${email}`);

    // Update candidate profile with skills for recommendations
    console.log('Step 2: Updating candidate profile with skills...');
    const candidateProfile = {
      userId: userId,
      skills: ['TypeScript', 'Node.js', 'React', 'Drizzle ORM'],
      experience: '5 years',
      location: 'Remote',
      workType: 'remote'
    };
    await api.post('/api/candidate/profile')
      .set('Authorization', `Bearer ${token}`)
      .send(candidateProfile)
      .expect(200);
    console.log('Candidate profile updated.');

    // Test external job ingestion
    console.log('Step 3: Testing external job ingestion...');
    const ingestionResponse = await api.get('/api/external-jobs?skills=typescript,nodejs')
      .expect(200);

    assert(ingestionResponse.body.jobs, 'Response should contain jobs array.');
    assert(ingestionResponse.body.ingestionStats, 'Response should contain ingestion stats.');
    assert(ingestionResponse.body.ingestionStats.inserted >= 0, 'Inserted count should be non-negative.');
    assert(ingestionResponse.body.ingestionStats.duplicates >= 0, 'Duplicates count should be non-negative.');
    console.log(`Ingestion Stats: Inserted: ${ingestionResponse.body.ingestionStats.inserted}, Duplicates: ${ingestionResponse.body.ingestionStats.duplicates}`);
    assert(ingestionResponse.body.jobs.length > 0 || ingestionResponse.body.ingestionStats.inserted > 0, 'Should have either found or inserted jobs.');
    console.log('External job ingestion test passed.');

    // Test job recommendations with trust scores
    console.log('Step 4: Testing job recommendations with trust scores...');
    const recommendationsResponse = await api.get('/api/ai-matches')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const recommendations = recommendationsResponse.body;
    assert(Array.isArray(recommendations), 'Recommendations should be an array.');
    assert(recommendations.length > 0, 'Should receive job recommendations.');

    // Assert that trust score indicators are present
    const firstRecommendation = recommendations[0].job;
    assert(typeof firstRecommendation.isVerifiedActive === 'boolean', 'isVerifiedActive should be a boolean.');
    assert(typeof firstRecommendation.isDirectFromCompany === 'boolean', 'isDirectFromCompany should be a boolean.');
    console.log('Trust score indicators present in recommendations.');

    // Verify ordering by trust score (simple check, assumes varied trust scores)
    // This is hard to assert strictly without mock data for trust scores,
    // so a loose check is performed here.
    if (recommendations.length > 1) {
      const highestScore = recommendations[0].job.confidenceScore * ((firstRecommendation.trustScore || 50) / 100);
      const secondScore = recommendations[1].job.confidenceScore * ((recommendations[1].job.trustScore || 50) / 100);
      assert(highestScore >= secondScore, 'Jobs should be sorted by combined match and trust score.');
    }
    console.log('Job recommendations with trust scores test passed.');

    // Test deduplication: call external-jobs again and expect higher duplicate count
    console.log('Step 5: Testing job deduplication...');
    const secondIngestionResponse = await api.get('/api/external-jobs?skills=typescript,nodejs')
      .expect(200);
    assert(secondIngestionResponse.body.ingestionStats.duplicates > 0 || secondIngestionResponse.body.ingestionStats.inserted === 0, 'Second ingestion should result in duplicates or no new inserts.');
    console.log('Job deduplication test passed.');

    console.log('✅ All Job Engine Tests Passed.');

  } catch (err) {
    console.error('\n--- ❌ JOB ENGINE TEST FAILED ---');
    console.error(err.message);
    process.exit(1);
  } finally {
    console.log('\n--- Cleaning up job engine test user ---');
    if (userId) {
      await deleteUser(userId);
    }
    // Note: Jobs ingested during tests are retained for verification
  }
}

// To run this test independently:
// runJobEngineTests().catch(console.error);
