/**
 * Autopilot (every minute on the VPS, via infra/vps/run-cron.sh).
 * Reads load, RAM and disk from this machine and connections + feed speed from
 * the database, decides with decideAutopilot(), applies switch changes as
 * 'autopilot' (pinned switches are refused by setSetting), emails each action
 * via infra/vps/alert.sh, and records a heartbeat in pipeline_runs every 15
 * minutes or whenever it acted.
 *
 *   npx tsx scripts/autopilot.ts            # decide and apply
 *   npx tsx scripts/autopilot.ts --dry-run  # decide and print, change nothing
 */
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { sql } from 'drizzle-orm/sql';
import { db } from '../server/db';
import { listSettings, setSetting, writeAudit, SETTING_DEFAULTS, type Settings } from '../server/services/runtime-settings.service';
import { decideAutopilot, isMissingTable, shouldReap, REAP_SQL, CONNECTIONS_SQL, type AutopilotInput, type AutopilotState, type SetBy } from '../server/services/autopilot.service';
import { recordPipelineRun } from '../server/services/pipeline-run.service';

const rows = (r: any): any[] => (r?.rows ?? r) as any[];
const DRY = process.argv.includes('--dry-run');
const STATE_FILE = process.env.AUTOPILOT_STATE_FILE || '/var/lib/recrutas-autopilot/state.json';

function readState(): AutopilotState {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { healthySince: {} }; }
}
function writeState(s: AutopilotState): void {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); }
  catch (err) { console.warn(`[autopilot] could not save state to ${STATE_FILE}: ${(err as Error).message}`); }
}
function memAvailableMb(): number {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) {return Number(m[1]) / 1024;}
  } catch { /* not Linux */ }
  return os.freemem() / 1024 / 1024;
}
function diskPct(): number {
  try { const s = fs.statfsSync('/'); return Math.round(100 * (1 - s.bavail / s.blocks)); } catch { return 0; }
}
function alert(key: string, subject: string, body: string): void {
  const script = path.resolve(process.cwd(), 'infra/vps/alert.sh');
  if (DRY || !fs.existsSync(script)) { console.log(`[autopilot] alert (not sent): ${subject}`); return; }
  spawnSync('bash', [script, key, subject, '-'], { input: body, stdio: ['pipe', 'inherit', 'inherit'] });
}

/**
 * Run SQL as the postgres superuser (peer auth on the box). Its reserved
 * connection slots still work when the app user is locked out. Returns the
 * trimmed output, or null when unavailable (e.g. not on the VPS).
 */
function superuser(query: string): string | null {
  const cmd = (process.env.AUTOPILOT_SUPERUSER_PSQL || 'sudo -u postgres psql -X -A -t').split(' ');
  const r = spawnSync(cmd[0], [...cmd.slice(1), '-c', query], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Close idle outside connections if connections are high or the app user can't connect. */
function reapIfNeeded(connections: number | null, appDbReachable: boolean): { closed: number } | null {
  if (!shouldReap(connections, appDbReachable) || DRY) {return null;}
  const out = superuser(REAP_SQL);
  return out === null ? null : { closed: Number(out) || 0 };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  // Count connections as the superuser first: it works even when the app user is locked out.
  const suCount = superuser(CONNECTIONS_SQL);
  const suConnections = suCount === null ? null : Number(suCount);
  let current;
  try {
    current = await listSettings();
  } catch (err) {
    if (isMissingTable(err)) {
      console.log(`[autopilot] switches table not migrated yet, nothing to do`);
      return;
    }
    // The app user can't read the database: most likely connections are exhausted.
    const reaped = reapIfNeeded(suConnections, false);
    const msg = (err as Error).message.slice(0, 300);
    alert('autopilot-db-unreachable', `[recrutas] Autopilot can't reach the database (${suConnections ?? '?'} connections)`,
      `Autopilot could not read its switches as the app user: ${msg}\n\n`
      + `Connections in use (superuser count): ${suConnections ?? 'unknown'}.\n`
      + (reaped ? `Closed ${reaped.closed} idle outside connection(s) idle > 2 min.\n` : 'No connections closed.\n')
      + 'If this repeats, check pgBouncer (systemctl status pgbouncer) and pg_stat_activity.');
    console.error(`[autopilot] database unreachable as app user (${suConnections ?? '?'} connections)${reaped ? `, closed ${reaped.closed} idle` : ''}: ${msg}`);
    process.exitCode = 1;
    return;
  }
  const settings = { ...SETTING_DEFAULTS } as Settings;
  const setBy: SetBy = {};
  for (const s of current) { (settings as any)[s.key] = s.value; setBy[s.key] = s.updatedBy; }

  const [feed, conns, backlog] = await Promise.all([
    db.execute(sql`
      SELECT count(*)::int AS n, percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95
      FROM request_metrics WHERE endpoint = '/api/ai-matches' AND created_at > NOW() - INTERVAL '15 minutes'`).then(r => rows(r)[0]),
    db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity`).then(r => rows(r)[0]),
    db.execute(sql`SELECT count(*)::int AS n FROM job_postings WHERE status = 'active' AND vector_embedding IS NULL`).then(r => rows(r)[0]).catch(() => null),
  ]);
  const input: AutopilotInput = {
    feedP95Ms: feed?.p95 === null || feed?.p95 === undefined ? null : Number(feed.p95),
    feedSamples: Number(feed?.n) || 0,
    load1: os.loadavg()[0],
    cpus: os.cpus().length,
    memAvailableMb: memAvailableMb(),
    dbConnections: suConnections ?? (Number(conns?.n) || 0),
    diskPct: diskPct(),
    embeddingBacklog: backlog ? Number(backlog.n) : null,
  };

  const reaped = reapIfNeeded(input.dbConnections, true);
  if (reaped) {
    alert('autopilot-db-reap', `[recrutas] Autopilot closed ${reaped.closed} idle DB connection(s) (${input.dbConnections} in use)`,
      `Connections were over the limit (${input.dbConnections}). Autopilot closed ${reaped.closed} idle connection(s) from outside the server, idle > 2 min. Local clients (pgBouncer, crons) were not touched.`);
    await writeAudit('autopilot', 'db.reap_idle', 'pg_stat_activity', { connections: input.dbConnections, closed: reaped.closed }, 'connections over the limit').catch(() => {});
  }

  const decision = decideAutopilot(input, settings, setBy, readState(), startedAt);
  const applied: string[] = [];
  const refused: string[] = [];
  for (const c of decision.changes) {
    if (DRY) { applied.push(`${c.key}=${JSON.stringify(c.value)} (dry run)`); continue; }
    const r = await setSetting(c.key, c.value, 'autopilot', c.reason);
    (r.ok ? applied : refused).push(r.ok ? `${c.key}=${JSON.stringify(c.value)}` : `${c.key}: ${r.error}`);
  }
  for (const a of decision.alerts) {alert(a.key, a.subject, a.body);}
  if (!DRY) {writeState(decision.state);}

  const summary = `load ${input.load1.toFixed(2)}/${input.cpus} · RAM ${Math.round(input.memAvailableMb)} MB · conns ${input.dbConnections} · disk ${input.diskPct}% · feed p95 ${input.feedP95Ms ?? 'n/a'} ms (${input.feedSamples})`;
  console.log(`[autopilot] ${summary}${applied.length ? ` · applied ${applied.join(', ')}` : ''}${refused.length ? ` · refused ${refused.join(', ')}` : ''}`);
  // A heartbeat every 15 minutes, and a row whenever it acted, so the admin console can show it's alive.
  if (!DRY && (applied.length || refused.length || decision.alerts.length || startedAt.getUTCMinutes() % 15 === 0)) {
    await recordPipelineRun({
      pipeline: 'autopilot', status: refused.length ? 'warning' : 'ok', startedAt,
      itemsProcessed: applied.length, itemsFailed: refused.length,
      message: applied.length ? `applied ${applied.join(', ')}` : summary,
      stats: { ...input, applied, refused, healthySince: decision.state.healthySince },
    });
  }
}

main().then(() => process.exit(0)).catch(err => { console.error('[autopilot] failed:', err); process.exit(1); });
