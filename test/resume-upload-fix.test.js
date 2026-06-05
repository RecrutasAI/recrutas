import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import supertest from 'supertest';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---
const PORT = 5001; // Match server port
const API_URL = `http://localhost:${PORT}`;
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const api = supertest(API_URL);

// --- Helper Functions ---

async function createNewUserAndGetToken() {
  const email = `test-user-${Date.now()}@example.com`;
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

async function createUserInPublicSchema(userId, email) {
    const adminClient = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await adminClient.from('users').insert([{ id: userId, email: email, name: email, role: 'candidate' }]);
    if (error) {
        throw new Error(`Failed to create user in public schema: ${error.message}`);
    }
}

async function deleteUser(userId) {
    const adminAuthClient = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await adminAuthClient.auth.admin.deleteUser(userId);
    if(error) {
        console.error(`Failed to delete user ${userId}:`, error.message);
    }
}

// --- Test Runner ---

async function runTest() {
    let token, userId, email;
    try {
        console.log('Starting test: Resume Upload Fix Verification');

        console.log('Step 1: Creating a new user and getting token...');
        ({ token, userId, email } = await createNewUserAndGetToken());
        console.log(`User created with email: ${email}`);

        console.log('Step 2: Creating user in public schema...');
        await createUserInPublicSchema(userId, email);
        console.log('User created in public schema.');

        const resumePath = path.resolve(__dirname, '../test-resume.pdf');
        if (!fs.existsSync(resumePath)) {throw new Error(`Test resume not found at ${resumePath}`);}

        // --- Run The Test ---
        console.log('\n--- Running Test ---');
        console.log('Expecting test to PASS and response to be a full user profile...');

        const response = await api.post('/api/candidate/resume')
            .set('Authorization', `Bearer ${token}`)
            .attach('resume', resumePath);

        // Assertions
        if (response.status !== 200) {throw new Error(`Expected status 200 but got ${response.status}`);}
        
        console.log('Response Body:', JSON.stringify(response.body, null, 2));

        // Validate the response structure matches ResumeProcessingResult
        if (typeof response.body.parsed !== 'boolean') {
          throw new Error('Response body missing "parsed" boolean field.');
        }
        if (!response.body.aiParsing || typeof response.body.aiParsing.success !== 'boolean') {
          throw new Error('Response body missing "aiParsing" object with success field.');
        }
        if (!response.body.resumeUrl) {
          throw new Error('Response body missing "resumeUrl" field.');
        }

        console.log('✅ Test Passed. Resume upload returns correct ResumeProcessingResult structure.');

    } catch (err) {
        console.error('\n--- ❌ TEST FAILED ---');
        console.error(err.message);
        process.exit(1);
    } finally {
        // --- Cleanup ---
        console.log('\n--- Cleaning up ---');
        if (userId) {
            console.log(`Deleting test user: ${email}`);
            await deleteUser(userId);
        }
    }
}

runTest();