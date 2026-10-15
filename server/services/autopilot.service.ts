/**
 * Autopilot: protects the site under load by flipping the console's switches
 * itself, then turning them back when things recover (docs/scaling-strategy.md,
 * "Auto-scaling"). It never changes infrastructure, never deletes anything,
 * never touches a pinned switch, and only undoes changes it made itself.
 *
 *   pressure                                   → action                                 recovers when (15 min)
 *   feed p95 > 2 s (≥5 requests) or load > 1.5×cores → feed cache on, lifetime → 6 h     feed p95 < 1 s and load < 1.0×cores
 *   load > 1.5×cores or RAM free < 200 MB      → pause background jobs                  load < 1.0×cores and RAM > 400 MB
 *   DB connections > 40                        → pause background jobs + busy banner    connections < 25
 *   feed p95 > 2 s for 15 min with the cache   → sign-up waitlist (last step; existing  feed p95 < 1 s and load < 1.0×cores
 *     already at 6 h (users actually slow)        users unaffected)
 *   Supabase (sign-in, resume files) down 2 min → "sign-in unavailable" banner + alert Supabase up for 5 min
 *     (resume uploads already fall back to our Postgres: server/lib/resume-files.ts)
 *   Supabase down 5 min, our backup sign-in    → switch sign-in to the backup + banner   never by itself: an admin
 *     server reachable and copied < 30 min ago    (infra/vps/auth)                        switches back
 *   disk > 85%, a new job unmatched > 14 h     → alert only
 *
 * decideAutopilot() is pure (unit-tested); scripts/autopilot.ts gathers the
 * numbers on the VPS every minute and applies the result.
 */
import type { Settings } from './runtime-settings.service';

export interface AutopilotInput {
  feedP95Ms: number | null;
  feedSamples: number;
  load1: number;
  cpus: number;
  memAvailableMb: number;
  dbConnections: number;
  diskPct: number;
  /** Live jobs with no embedding yet: they can't be matched until it catches up. */
  embeddingBacklog?: number | null;
  /** Minutes since any job was last embedded. Batches run every 6 h: over 14 h means two were missed. */
  embeddingSinceLastMin?: number | null;
  /**
   * Waiting jobs a batch should already have embedded: created and last changed over an hour
   * before the newest embedding, yet still without one. Not the oldest job's age: a closed job
   * that its board lists again is reopened with its old created_at, and on 2026-10-14 one such
   * job made the alert say "20 hours" a minute after it started waiting.
   */
  embeddingSkipped?: number | null;
  /** Supabase sign-in and storage both answered; null when not checked. */
  supabaseUp?: boolean | null;
  /** Our backup sign-in server answers publicly and its account copy is under 30 min old. */
  backupAuthReady?: boolean | null;
}

/** Who last set each switch (from runtime_settings.updated_by), so Autopilot only undoes its own changes. */
export type SetBy = Partial<Record<keyof Settings, string | null>>;

export interface AutopilotState {
  /** When each rule last became healthy (ISO), cleared while under pressure. */
  healthySince: Partial<Record<RuleKey, string>>;
  /** Since when people have been seeing a slow feed (ISO), cleared once it isn't. */
  feedSlowSince?: string;  /** Since when Supabase has been down / up (ISO); one of them is set once it has been checked. */
  supabaseDownSince?: string;
  supabaseUpSince?: string;
  /** Since when any rule has been under pressure (ISO), cleared once none is. */
  pressureSince?: string;
}

export type RuleKey = 'feed' | 'cpuRam' | 'conns';

export interface Change { key: keyof Settings; value: unknown; reason: string }
export interface Decision { changes: Change[]; alerts: { key: string; subject: string; body: string }[]; state: AutopilotState }

export const HOLD_MS = 15 * 60_000;
/** Supabase must be down this long before the banner (one failed check can be a blip)… */
export const SUPABASE_DOWN_MS = 2 * 60_000;
/** …and up this long before it comes down. */
export const SUPABASE_UP_MS = 5 * 60_000;
export const SUPABASE_FAILOVER_MS = 5 * 60_000;
export const FAILOVER_NOTICE = { text: 'Sign-in moved to our backup while our provider is down. If asked, sign in again with your usual password.', level: 'warning' as const };
export const SUPABASE_NOTICE = { text: "Signing in is temporarily unavailable. If you're already signed in, your feed keeps working.", level: 'warning' as const };
export const BUSY_NOTICE = { text: "We're busier than usual right now. Pages may take a little longer to load.", level: 'warning' as const };
const NORMAL_TTL_MINUTES = 120;
/** Alert when the oldest unmatched job is older than this (two missed 6-hourly batches). */
export const EMBED_ALERT_MIN = 14 * 60;
/** Switches people can see: their changes are emailed at once. The rest is internal protection. */
const PEOPLE_VISIBLE = new Set<string>(['signupWaitlist', 'noticeBanner', 'authProvider']);
const PRESSURE_ALERT_MS = 60 * 60_000;
const PRESSURE_TTL_MINUTES = 360;

export function decideAutopilot(i: AutopilotInput, settings: Settings, setBy: SetBy, prev: AutopilotState, now: Date): Decision {
  const loadPerCpu = i.cpus > 0 ? i.load1 / i.cpus : 0;
  const feedSlow = i.feedSamples >= 5 && i.feedP95Ms !== null && i.feedP95Ms > 2000;
  const feedOk = i.feedSamples < 5 || i.feedP95Ms === null || i.feedP95Ms < 1000;

  const pressure: Record<RuleKey, boolean> = {
    feed: feedSlow || loadPerCpu > 1.5,
    cpuRam: loadPerCpu > 1.5 || i.memAvailableMb < 200,
    conns: i.dbConnections > 40,
  };
  const healthyNow: Record<RuleKey, boolean> = {
    feed: feedOk && loadPerCpu < 1.0,
    cpuRam: loadPerCpu < 1.0 && i.memAvailableMb > 400,
    conns: i.dbConnections < 25,
  };

  // Track how long each rule has been healthy; pressure (or the grey zone) resets it.
  const healthySince: AutopilotState['healthySince'] = {};
  for (const r of Object.keys(pressure) as RuleKey[]) {
    if (healthyNow[r] && !pressure[r]) {healthySince[r] = prev.healthySince[r] ?? now.toISOString();}
  }
  // Only real slowness counts here, not CPU alone: background work can load the box
  // without anyone waiting, and that must never close sign-ups.
  const feedSlowSince = feedSlow ? (prev.feedSlowSince ?? now.toISOString()) : undefined;
  const slowTooLong = !!feedSlowSince && now.getTime() - Date.parse(feedSlowSince) >= HOLD_MS;
  const supabaseDownSince = i.supabaseUp === false ? (prev.supabaseDownSince ?? now.toISOString()) : undefined;
  const supabaseUpSince = i.supabaseUp === true ? (prev.supabaseUpSince ?? now.toISOString()) : undefined;
  const supabaseDownLong = !!supabaseDownSince && now.getTime() - Date.parse(supabaseDownSince) >= SUPABASE_DOWN_MS;
  const supabaseUpLong = !!supabaseUpSince && now.getTime() - Date.parse(supabaseUpSince) >= SUPABASE_UP_MS;
  const supabaseFailover = !!supabaseDownSince && now.getTime() - Date.parse(supabaseDownSince) >= SUPABASE_FAILOVER_MS;
  const recovered = (r: RuleKey) => !!healthySince[r] && now.getTime() - Date.parse(healthySince[r]!) >= HOLD_MS;
  const mine = (k: keyof Settings) => setBy[k] === 'autopilot';

  const why = [
    feedSlow ? `feed p95 ${(i.feedP95Ms! / 1000).toFixed(1)} s over ${i.feedSamples} requests` : null,
    loadPerCpu > 1.5 ? `CPU load ${i.load1.toFixed(2)} on ${i.cpus} cores` : null,
    i.memAvailableMb < 200 ? `RAM free ${Math.round(i.memAvailableMb)} MB` : null,
    i.dbConnections > 40 ? `${i.dbConnections} DB connections` : null,
  ].filter(Boolean).join(', ');

  const changes: Change[] = [];
  const set = (key: keyof Settings, value: unknown, reason: string) => {
    if (JSON.stringify(settings[key]) !== JSON.stringify(value)) {changes.push({ key, value, reason });}
  };

  if (settings.autopilot) {
    // Rule: feed under pressure → serve cached feeds longer.
    if (pressure.feed) {
      set('feedCache', true, `Autopilot: ${why}`);
      if (settings.feedCacheTtlMinutes < PRESSURE_TTL_MINUTES) {set('feedCacheTtlMinutes', PRESSURE_TTL_MINUTES, `Autopilot: ${why}`);}
    } else if (recovered('feed')) {
      if (mine('feedCacheTtlMinutes') && settings.feedCacheTtlMinutes !== NORMAL_TTL_MINUTES) {set('feedCacheTtlMinutes', NORMAL_TTL_MINUTES, 'Autopilot: feed fast again for 15 min');}
      if (mine('feedCache') && settings.feedCache) {set('feedCache', false, 'Autopilot: feed fast again for 15 min');}
    }

    // Last step: the cache is already stretched and people are still waiting → new sign-ups
    // join the waitlist so everyone already here keeps a working site.
    if (slowTooLong && settings.feedCache && settings.feedCacheTtlMinutes >= PRESSURE_TTL_MINUTES) {
      set('signupWaitlist', true, `Autopilot: feed slow for 15 min with the cache at 6 h (${why})`);
    } else if (recovered('feed') && mine('signupWaitlist') && settings.signupWaitlist) {
      set('signupWaitlist', false, 'Autopilot: feed fast again for 15 min');
    }
    // Rules: CPU/RAM or connections under pressure → pause background jobs; connections also get the banner.
    if (pressure.cpuRam || pressure.conns) {
      set('pauseNonEssentialCrons', true, `Autopilot: ${why}`);
    } else if (recovered('cpuRam') && recovered('conns') && mine('pauseNonEssentialCrons') && settings.pauseNonEssentialCrons) {
      set('pauseNonEssentialCrons', false, 'Autopilot: CPU, RAM and connections healthy for 15 min');
    }
    if (pressure.conns) {
      if (settings.noticeBanner === null) {set('noticeBanner', BUSY_NOTICE, `Autopilot: ${why}`);}
    } else if (recovered('conns') && mine('noticeBanner') && settings.noticeBanner?.text === BUSY_NOTICE.text) {
      set('noticeBanner', null, 'Autopilot: connections healthy for 15 min');
    }
    const onBackup = settings.authProvider === 'recrutas';
    const ourBanner = settings.noticeBanner === null
      || (mine('noticeBanner') && [SUPABASE_NOTICE.text, BUSY_NOTICE.text].includes(settings.noticeBanner.text));
    // Supabase down long enough and the backup is ready: move sign-in there. Never back by itself.
    if (!onBackup && supabaseFailover && i.backupAuthReady === true) {
      set('authProvider', 'recrutas', 'Autopilot: Supabase (sign-in) down 5 min; backup sign-in server ready');
      if (ourBanner) {set('noticeBanner', FAILOVER_NOTICE, 'Autopilot: sign-in moved to the backup');}
    } else if (!onBackup && supabaseDownLong) {
      // Down, no backup ready (yet): say so instead of letting sign-in fail without explanation.
      if (settings.noticeBanner === null) {set('noticeBanner', SUPABASE_NOTICE, 'Autopilot: Supabase (sign-in) not answering for 2 min');}
    } else if (supabaseUpLong && mine('noticeBanner') && settings.noticeBanner?.text === SUPABASE_NOTICE.text) {
      set('noticeBanner', null, 'Autopilot: Supabase answering again for 5 min');
    }
  }

  const alerts: Decision['alerts'] = [];
  if (i.diskPct > 85) {
    alerts.push({ key: 'autopilot-disk', subject: `[recrutas] disk ${i.diskPct}% full`, body: `The VPS disk is ${i.diskPct}% full. Check WAL and backup retention first (the usual cause), then add a volume. Autopilot does not act on disk.` });
  }
  // Thousands waiting between the 6-hourly batches is normal. Trouble is batches not running,
  // or running and leaving jobs behind.
  const stalled = (i.embeddingSinceLastMin ?? 0) > EMBED_ALERT_MIN;
  const skipped = i.embeddingSkipped ?? 0;
  if ((i.embeddingBacklog ?? 0) > 0 && (stalled || skipped > 0)) {
    const h = ((i.embeddingSinceLastMin ?? 0) / 60).toFixed(1);
    alerts.push({
      key: 'autopilot-embedding-backlog',
      subject: stalled
        ? `[recrutas] no new jobs matched for ${h} h (${i.embeddingBacklog} waiting)`
        : `[recrutas] ${skipped} jobs left unmatched by the last batch`,
      body: stalled
        ? `${i.embeddingBacklog} live jobs have no matching data, and no job has been embedded for ${h} hours: at least two 6-hourly batches were missed, so new jobs are not reaching candidates. Check /opt/recrutas/logs/batch-embeddings.log. Admin console → Today → "Match new jobs now" runs a batch.`
        : `${skipped} live jobs were already waiting when the last batch ran, and it didn't embed them (of ${i.embeddingBacklog} waiting in all). Look for errors in /opt/recrutas/logs/batch-embeddings.log; the next batch retries them.`,
    });
  }
  if (settings.authProvider === 'recrutas' && supabaseUpLong) {
    alerts.push({ key: 'autopilot-supabase-back', subject: '[recrutas] Supabase is back; sign-in is still on our backup', body: 'Supabase has answered for 5 minutes. Sign-in stays on our backup server until you switch it back in the admin console (System → Sign-in server). Before switching back: accounts created or passwords changed on the backup since the switch exist only there.' });
  }
  if (supabaseDownLong && settings.authProvider !== 'recrutas') {
    alerts.push({ key: 'autopilot-supabase-down', subject: '[recrutas] Supabase not answering: sign-in is down', body: `Supabase sign-in or storage has not answered since ${supabaseDownSince}. People already signed in keep their feed until their session needs renewing (up to an hour); new sign-ins fail. Resume uploads are being kept in our Postgres and move back on their own (move-fallback-resumes). Check status.supabase.com and the project's usage page (a free-plan restriction returns 402).` });
  }
  // Email only what someone has to know about. A switch people can see (sign-up waitlist, the
  // site banner, the sign-in server) emails when it changes. Internal protection (a longer feed
  // cache, pausing background jobs) used to email on every flip, both ways, often for its own
  // morning scrape: about 10 of the owner's ~39 emails a week (2026-10-14). Now it emails only
  // when pressure has lasted an hour; each change stays in the admin console's audit log.
  const pressureSince = Object.values(pressure).some(Boolean) ? (prev.pressureSince ?? now.toISOString()) : undefined;
  if (pressureSince && now.getTime() - Date.parse(pressureSince) >= PRESSURE_ALERT_MS) {
    alerts.push({
      key: 'autopilot-pressure-long',
      subject: `[recrutas] Under load for ${Math.round((now.getTime() - Date.parse(pressureSince)) / 60_000)} min; Autopilot is protecting the site`,
      body: `Pressure since ${pressureSince}: feed p95 ${i.feedP95Ms ?? 'n/a'} ms (${i.feedSamples} req), load ${i.load1.toFixed(2)}/${i.cpus} cores, RAM free ${Math.round(i.memAvailableMb)} MB, DB connections ${i.dbConnections}. The cache is stretched and background jobs are paused until it eases. If this is real traffic and keeps up, it's the signal to upgrade the box (docs/scaling-strategy.md).`,
    });
  }
  const visible = changes.filter(c => PEOPLE_VISIBLE.has(c.key));
  if (visible.length) {
    alerts.push({
      key: `autopilot-${visible.map(c => `${c.key}=${JSON.stringify(c.value)}`).join(',')}`,
      subject: `[recrutas] Autopilot: ${visible.map(c => `${c.key} → ${JSON.stringify(c.value)}`).join(', ')}`,
      body: visible.map(c => `${c.key} → ${JSON.stringify(c.value)}\n  ${c.reason}`).join('\n\n')
        + `\n\nInputs: feed p95 ${i.feedP95Ms ?? 'n/a'} ms (${i.feedSamples} req), load ${i.load1.toFixed(2)}/${i.cpus} cores, RAM free ${Math.round(i.memAvailableMb)} MB, DB connections ${i.dbConnections}, disk ${i.diskPct}%.`
        + '\n\nPin a switch in the admin console (System & scaling) to stop Autopilot changing it.',
    });
  }
  return {
    changes, alerts,
    state: {
      healthySince,
      ...(feedSlowSince ? { feedSlowSince } : {}),
      ...(supabaseDownSince ? { supabaseDownSince } : {}),
      ...(supabaseUpSince ? { supabaseUpSince } : {}),
      ...(pressureSince ? { pressureSince } : {}),
    },
  };
}

/**
 * Database connection pressure (added 2026-10-08, after a real exhaustion).
 * Frozen Vercel instances held idle connections until max_connections (60)
 * ran out; Autopilot itself then couldn't connect and logged "switches table
 * not available yet", doing nothing. Now:
 *   - only a genuinely missing table means "not migrated yet"; any other read
 *     failure emails an alert;
 *   - above REAP_AT_CONNECTIONS, or when the app user can't connect at all,
 *     idle connections from OUTSIDE the box that have been idle > 2 minutes are
 *     closed through the postgres superuser (whose reserved slots still work).
 *     Local clients (pgBouncer, VPS crons) are never touched, and nothing
 *     mid-query or mid-transaction is closed.
 */
export const REAP_AT_CONNECTIONS = 40;
export const REAP_IDLE_SECONDS = 120;

export function shouldReap(connections: number | null, appDbReachable: boolean): boolean {
  return !appDbReachable || (connections ?? 0) > REAP_AT_CONNECTIONS;
}

/** Closes idle app connections from outside the box; returns how many it closed. */
export const REAP_SQL = `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid)) FROM pg_stat_activity
WHERE usename = 'recrutas_app' AND state = 'idle'
  AND client_addr IS NOT NULL AND host(client_addr) NOT IN ('127.0.0.1', '::1')
  AND now() - state_change > interval '${REAP_IDLE_SECONDS} seconds'`;

export const CONNECTIONS_SQL = `SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'`;

/** True only when the error is "this table doesn't exist yet" (Postgres 42P01). */
export function isMissingTable(err: unknown): boolean {
  const e = err as any;
  const code = e?.code ?? e?.cause?.code;
  const msg = String(e?.message ?? '') + ' ' + String(e?.cause?.message ?? '');
  return code === '42P01' || /relation "?[\w.]+"? does not exist/i.test(msg);
}
