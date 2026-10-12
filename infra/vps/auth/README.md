# Backup sign-in server

Supabase runs sign-in. This is our **fallback** for when it can't (outage, or a free-plan
402 restriction): Supabase's own open-source sign-in server (Supabase Auth / GoTrue),
running on the VPS against our Postgres in schema `auth`, with a copy of every account.

- **Same tokens.** It signs with the same secret as Supabase (`SUPABASE_JWT_SECRET`), so
  the API (`server/middleware/auth.ts`) accepts tokens from either server unchanged.
- **Same paths.** Caddy serves it at `https://auth.recrutas.ai/auth/v1/*`, the shape
  supabase-js expects, so the browser just uses another base URL.
- **Supabase stays the source of accounts.** `sync-auth-users.sh` replaces our copy every
  10 minutes (cron `sync-auth-users`) and touches `/opt/recrutas/auth/last-sync`.

## Switching

The console switch **System → Sign-in server** (`authProvider`: `supabase` | `recrutas`):

- `/api/site/status` returns `authUrl` while it is `recrutas`; every page
  (`useSiteStatus`) stores it and reloads once, so the sign-in client uses the backup.
  Switching back clears it the same way. Everyone is signed out once each way; passwords
  keep working.
- The extension renews tokens through `/api/auth/extension-refresh`, which follows the
  switch (`server/lib/auth-provider.ts`).
- **Autopilot** switches to the backup when Supabase has not answered for 5 minutes AND
  the backup answers publicly AND its copy is under 30 minutes old; it shows a banner and
  emails. It **never switches back by itself**: it emails when Supabase is back, and an
  admin switches back.
- While on the backup, the copy job refuses to run, so accounts created or passwords
  changed during the failover are not overwritten. Before switching back, know that
  those changes exist only on the backup.

Server-side admin calls that use Supabase's admin API (account deletion, magic links in
scripts) still go to Supabase and will fail during an outage.

## Setup (once)

1. `setup-auth.sh`: downloads the pinned release (checksum verified), creates role
   `recrutas_auth` and schema `auth`, writes `/opt/recrutas/auth/auth.env` (secrets,
   never overwritten), applies the auth migrations, runs the `recrutas-auth` service on
   `127.0.0.1:9999` only.
2. `sync-auth-users.sh`: copies accounts (run by hand the first time; then cron).
3. DNS: A record `auth.recrutas.ai` → the VPS (Vercel → Domains → recrutas.ai).
4. `enable-public.sh`: Caddy with automatic HTTPS, opens ports 80/443, checks
   `https://auth.recrutas.ai/auth/v1/health`.
5. Google sign-in: add `https://auth.recrutas.ai/auth/v1/callback` as an authorized
   redirect URI on the Google OAuth client; put the client ID/secret in `auth.env`
   (`GOTRUE_EXTERNAL_GOOGLE_*`, `..._ENABLED=true`). Turnstile: put the secret in
   `GOTRUE_SECURITY_CAPTCHA_SECRET` with `..._ENABLED=true`. Then
   `systemctl restart recrutas-auth`.
6. Test every path against the backup with the test account before relying on it.

Upgrading: change `VERSION`/`SHA256` in `setup-auth.sh` to match the version Supabase
runs (`select max(version) from auth.schema_migrations` on both sides must agree, or the
copy refuses), re-run it.
