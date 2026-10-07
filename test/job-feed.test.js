import assert from 'node:assert';
import { supabase } from '../server/lib/supabase-client.ts';
import { DatabaseStorage } from '../server/storage.ts';

export async function runJobFeedAPITest() {
  const email = (process.env.E2E_CANDIDATE_EMAIL ?? '');
  const password = (process.env.E2E_CANDIDATE_PASSWORD ?? '');
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  assert.ifError(error, 'Sign-in should not produce an error.');
  assert(data.session, 'Session data should exist.');
  const token = data.session.access_token;
  assert(token, 'Access token should be present.');

  const userId = data.session.user.id;
  const storage = new DatabaseStorage();
  await storage.upsertUser({
    id: userId,
    email: email,
  });

  await storage.upsertCandidateUser({
    userId: userId,
    skills: ['React', 'Node.js'],
    experience: '2 years',
    location: 'San Francisco, CA',
  });

  const response = await fetch('http://localhost:5001/api/ai-matches', {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  assert.strictEqual(response.status, 200, 'API should return a 200 OK status.');

  const matches = await response.json();
  assert(Array.isArray(matches), 'Response should be an array of matches.');
}
