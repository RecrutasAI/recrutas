
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { supabase } from '../server/lib/supabase-client.ts';
import { execSync } from 'child_process';
import FormData from 'form-data';

async function runResumeUploadTest() {
  // 1. Login to get an auth token
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

  // 2. Create a dummy resume file
  // const resumeContent = 'This is a dummy resume file.';
  // const resumeFileName = 'dummy-resume.pdf';
  // const resumeFilePath = path.join('/tmp', resumeFileName);
  // fs.writeFileSync(resumeFilePath, resumeContent);

  const resumeFileName = 'test-resume.pdf';
  const resumeFilePath = path.join(process.cwd(), resumeFileName);

  // 3. Prepare the form data
  const form = new FormData();
  form.append('resume', fs.createReadStream(resumeFilePath));

  // 4. Send the POST request
  const curlCommand = `curl -X POST -H "Authorization: Bearer ${token}" -F "resume=@${resumeFilePath}" http://localhost:5000/api/candidate/resume`;

  const output = execSync(curlCommand).toString();

  // 5. Assert the response
  const responseData = JSON.parse(output);
  console.log('Server response:', responseData);
  assert(responseData.resumeUrl, 'Response should contain a resume URL.');

  console.log('Resume upload test passed!');
  console.log('Resume URL:', responseData.resumeUrl);

  // 6. Clean up the dummy file
  fs.unlinkSync(resumeFilePath);
}

runResumeUploadTest().catch(err => {
    console.error(err);
    process.exit(1);
});
