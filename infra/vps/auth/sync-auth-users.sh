#!/bin/bash
# Copy sign-in accounts (auth.users + auth.identities, with password hashes) from
# Supabase into our own sign-in server's schema. Step 2 of infra/vps/auth/README.md.
#
# Our server is the BACKUP: Supabase stays the source of accounts, and this replaces our
# copy with Supabase's current accounts (cron, every 10 minutes). While sign-in runs on
# the backup (console switch authProvider = recrutas), accounts made there exist only
# there, so it refuses to run: nothing created during a failover is overwritten.
#
#   ssh root@<vps> 'bash /opt/recrutas/app/infra/vps/auth/sync-auth-users.sh'
set -euo pipefail

DIR=/opt/recrutas/auth
APP_ENV=/opt/recrutas/app/.env
DB=recrutas
PG_DUMP=/usr/lib/postgresql/17/bin/pg_dump

if [ ! -f "$DIR/auth.env" ]; then
  echo "Backup sign-in server not set up (run setup-auth.sh first); nothing to copy."
  exit 0
fi
provider=$(sudo -u postgres psql -At "$DB" -c "select value #>> '{}' from runtime_settings where key = 'authProvider'" 2>/dev/null || true)
if [ "$provider" = "recrutas" ]; then
  echo "Refusing: sign-in is running on our backup now (authProvider = recrutas); its accounts are the newer ones." >&2
  exit 1
fi
SRC=$(grep '^SUPABASE_DIRECT_URL=' "$APP_ENV" | head -1 | cut -d= -f2- | tr -d '"')
[ -n "$SRC" ] || { echo "SUPABASE_DIRECT_URL missing in $APP_ENV" >&2; exit 1; }

# Same database layout on both sides, or the copy could drop columns.
theirs=$(psql "$SRC" -At -c 'select max(version) from auth.schema_migrations')
ours=$(sudo -u postgres psql -At "$DB" -c 'select max(version) from auth.schema_migrations')
if [ "$theirs" != "$ours" ]; then
  echo "Layout differs: Supabase at $theirs, ours at $ours. Update VERSION in setup-auth.sh first." >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"
"$PG_DUMP" "$SRC" --data-only --no-owner --no-privileges \
  --table=auth.users --table=auth.identities > "$TMP/accounts.sql"

# One transaction: either our copy is replaced in full, or nothing changes.
{
  echo 'BEGIN;'
  echo 'TRUNCATE auth.identities, auth.users CASCADE;'
  cat "$TMP/accounts.sql"
  echo 'COMMIT;'
} | sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$DB"

# Autopilot only fails over to a copy younger than 30 minutes (scripts/autopilot.ts).
touch "$DIR/last-sync"
sudo -u postgres psql -At "$DB" -c "select 'ours: ' || (select count(*) from auth.users) || ' accounts, ' || (select count(*) from auth.identities) || ' identities'"
psql "$SRC" -At -c "select 'supabase: ' || (select count(*) from auth.users) || ' accounts, ' || (select count(*) from auth.identities) || ' identities'"
