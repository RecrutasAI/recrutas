// Mint a Supabase session for the benchmark's test candidate via an admin
// magic link. Run with the app's .env loaded; writes session.json (mode 600).
import { writeFileSync } from 'fs';
const [, , EMAIL, OUT = 'session.json'] = process.argv;
const U = process.env.SUPABASE_URL, S = process.env.SUPABASE_SERVICE_ROLE_KEY;
const A = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
let r = await fetch(`${U}/auth/v1/admin/generate_link`, { method: 'POST',
  headers: { apikey: S, Authorization: `Bearer ${S}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', email: EMAIL }) });
let j = await r.json();
r = await fetch(`${U}/auth/v1/verify`, { method: 'POST', headers: { apikey: A, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', token_hash: j.hashed_token || j.properties?.hashed_token }) });
j = await r.json();
if (!j.access_token) { console.error('mint failed', r.status); process.exit(1); }
writeFileSync(OUT, JSON.stringify(j), { mode: 0o600 });
console.log('session ok');
