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
 *   disk > 85%, embedding backlog > 500        → alert only
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
}

/** Who last set each switch (from runtime_settings.updated_by), so Autopilot only undoes its own changes. */
export type SetBy = Partial<Record<keyof Settings, string | null>>;

export interface AutopilotState {
  /** When each rule last became healthy (ISO), cleared while under pressure. */
  healthySince: Partial<Record<RuleKey, string>>;
}

export type RuleKey = 'feed' | 'cpuRam' | 'conns';

export interface Change { key: keyof Settings; value: unknown; reason: string }
export interface Decision { changes: Change[]; alerts: { key: string; subject: string; body: string }[]; state: AutopilotState }

export const HOLD_MS = 15 * 60_000;
export const BUSY_NOTICE = { text: "We're busier than usual right now. Pages may take a little longer to load.", level: 'warning' as const };
const NORMAL_TTL_MINUTES = 120;
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

    // Rules: CPU/RAM or connections under pressure → pause background jobs; connections also get the banner.
    if (pressure.cpuRam || pressure.conns) {
      set('pauseNonEssentialCrons', true, `Autopilot: ${why}`);
    } else if (recovered('cpuRam') && recovered('conns') && mine('pauseNonEssentialCrons') && settings.pauseNonEssentialCrons) {
      set('pauseNonEssentialCrons', false, 'Autopilot: CPU, RAM and connections healthy for 15 min');
    }
    if (pressure.conns) {
      if (settings.noticeBanner === null) {set('noticeBanner', BUSY_NOTICE, `Autopilot: ${why}`);}
    } else if (recovered('conns') && mine('noticeBanner') && settings.noticeBanner !== null) {
      set('noticeBanner', null, 'Autopilot: connections healthy for 15 min');
    }
  }

  const alerts: Decision['alerts'] = [];
  if (i.diskPct > 85) {
    alerts.push({ key: 'autopilot-disk', subject: `[recrutas] disk ${i.diskPct}% full`, body: `The VPS disk is ${i.diskPct}% full. Check WAL and backup retention first (the usual cause), then add a volume. Autopilot does not act on disk.` });
  }
  if ((i.embeddingBacklog ?? 0) > 500) {
    alerts.push({ key: 'autopilot-embedding-backlog', subject: `[recrutas] ${i.embeddingBacklog} live jobs waiting for embeddings`, body: `${i.embeddingBacklog} live jobs have no embedding yet, so they can't be matched to anyone. Check the batch-embeddings cron (last run and errors) in the admin console's Pipelines view. If the box is busy, pausing background jobs lets embedding catch up.` });
  }
  if (changes.length) {
    alerts.push({
      key: `autopilot-${changes.map(c => `${c.key}=${JSON.stringify(c.value)}`).join(',')}`,
      subject: `[recrutas] Autopilot: ${changes.map(c => `${c.key} → ${JSON.stringify(c.value)}`).join(', ')}`,
      body: changes.map(c => `${c.key} → ${JSON.stringify(c.value)}\n  ${c.reason}`).join('\n\n')
        + `\n\nInputs: feed p95 ${i.feedP95Ms ?? 'n/a'} ms (${i.feedSamples} req), load ${i.load1.toFixed(2)}/${i.cpus} cores, RAM free ${Math.round(i.memAvailableMb)} MB, DB connections ${i.dbConnections}, disk ${i.diskPct}%.`
        + '\n\nPin a switch in the admin console (System & scaling) to stop Autopilot changing it.',
    });
  }
  return { changes, alerts, state: { healthySince } };
}
