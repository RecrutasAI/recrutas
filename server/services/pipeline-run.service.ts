/**
 * Pipeline-run heartbeats.
 *
 * Scheduled scripts (GitHub Actions crons — ingestion, embeddings) call
 * `runAsPipeline(name, fn)` (or `recordPipelineRun` directly) so each run leaves
 * a row in `pipeline_runs`. The admin page reads `getPipelineHealth()` to show,
 * per pipeline, the last run's status/age/counts — and flags a pipeline as STALE
 * when it hasn't reported within its expected interval (which also catches a
 * script that dies before it can report a failure).
 *
 * Recording is best-effort: a heartbeat write must never fail the actual job.
 */

import { db } from '../db.js';
import { pipelineRuns } from '../../shared/schema.js';
import { sql } from 'drizzle-orm/sql';

export type PipelineStatus = 'ok' | 'warning' | 'failed';

export interface PipelineSummary {
  status?: PipelineStatus;
  itemsProcessed?: number;
  itemsFailed?: number;
  message?: string;
  stats?: Record<string, unknown>;
}

// Expected cadence per pipeline, in minutes, INCLUDING slack. If `now - lastRun`
// exceeds this, the pipeline is considered stale (likely failing to even start).
// Keys are the canonical pipeline names passed to runAsPipeline/recordPipelineRun.
export const PIPELINE_MAX_AGE_MIN: Record<string, number> = {
  'batch-embeddings': 6 * 60 + 90,        // every 6h
  'embed-candidates': 15 + 30,            // every 10 min — closes the keyword-only
                                          // window after a résumé upload
  'scrape-ats': 4 * 60 + 90,              // every 4h
  'scrape-external': 24 * 60 + 180,       // daily
  'scrape-tier': 12 * 60 + 180,           // twice daily
  'discover-companies': 24 * 60 + 180,    // daily
  'enforce-response-sla': 60 + 90,        // hourly — the 24h-response "one metric"
  'auto-hide-ghost-jobs': 24 * 60 + 180,  // daily
  'purge-old-jobs': 24 * 60 + 180,        // daily
  'retry-failed-parses': 24 * 60 + 180,   // daily
  'warm-candidate-matches': 24 * 60 + 180,// daily
  'cleanup-errors': 7 * 24 * 60 + 24 * 60,// weekly (+1d slack)
  'vps-db-health': 15 + 30,               // every 15 min — self-hosted DB liveness
};

export async function recordPipelineRun(input: {
  pipeline: string;
  status: PipelineStatus;
  startedAt: Date;
  itemsProcessed?: number;
  itemsFailed?: number;
  message?: string;
  stats?: Record<string, unknown>;
}): Promise<void> {
  try {
    const finishedAt = new Date();
    await db.insert(pipelineRuns).values({
      pipeline: input.pipeline,
      status: input.status,
      startedAt: input.startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - input.startedAt.getTime(),
      itemsProcessed: input.itemsProcessed ?? 0,
      itemsFailed: input.itemsFailed ?? 0,
      message: input.message?.slice(0, 2000),
      stats: input.stats ?? null,
    } as any);
  } catch (err: any) {
    // Never let heartbeat bookkeeping break the pipeline it's measuring.
    console.warn(`[PipelineRun] Failed to record run for ${input.pipeline}:`, err?.message);
  }
}

/**
 * Run a pipeline body and record exactly one heartbeat. The body may return a
 * PipelineSummary (counts/status/message); throwing records a 'failed' run and
 * re-throws so the process still exits non-zero (GitHub Action stays red too).
 */
export async function runAsPipeline(
  pipeline: string,
  fn: () => Promise<PipelineSummary | void>,
): Promise<void> {
  const startedAt = new Date();
  try {
    const summary = (await fn()) || {};
    await recordPipelineRun({
      pipeline,
      startedAt,
      status: summary.status ?? 'ok',
      itemsProcessed: summary.itemsProcessed,
      itemsFailed: summary.itemsFailed,
      message: summary.message,
      stats: summary.stats,
    });
  } catch (err: any) {
    await recordPipelineRun({
      pipeline,
      startedAt,
      status: 'failed',
      message: err?.message ?? String(err),
    });
    throw err;
  }
}

export interface PipelineHealth {
  pipeline: string;
  status: PipelineStatus | 'stale' | 'never';
  lastRunStatus: PipelineStatus | null;
  lastRunAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
  expectedMaxAgeMinutes: number | null;
  itemsProcessed: number | null;
  itemsFailed: number | null;
  durationMs: number | null;
  message: string | null;
}

/**
 * Latest run per known pipeline, with staleness derived from PIPELINE_MAX_AGE_MIN.
 * Always returns a row for every registered pipeline (even with no runs yet) so a
 * pipeline that has been dead since before instrumentation still shows up.
 */
export async function getPipelineHealth(): Promise<PipelineHealth[]> {
  // DISTINCT ON gives the most-recent row per pipeline in one query.
  const result: any = await db.execute(sql`
    SELECT DISTINCT ON (pipeline)
      pipeline, status, started_at, finished_at, duration_ms,
      items_processed, items_failed, message, created_at
    FROM pipeline_runs
    ORDER BY pipeline, created_at DESC
  `);
  const list: any[] = Array.isArray(result) ? result : (result?.rows ?? []);
  const byPipeline = new Map<string, any>();
  for (const r of list) byPipeline.set(r.pipeline, r);

  // Union of registered pipelines and any others that have reported.
  const names = new Set<string>([...Object.keys(PIPELINE_MAX_AGE_MIN), ...byPipeline.keys()]);
  const now = Date.now();

  return [...names].sort().map((pipeline) => {
    const r = byPipeline.get(pipeline);
    const expectedMaxAgeMinutes = PIPELINE_MAX_AGE_MIN[pipeline] ?? null;
    if (!r) {
      return {
        pipeline, status: 'never', lastRunStatus: null, lastRunAt: null,
        ageMinutes: null, stale: false, expectedMaxAgeMinutes,
        itemsProcessed: null, itemsFailed: null, durationMs: null, message: null,
      };
    }
    const lastRunAt = new Date(r.finished_at ?? r.created_at);
    const ageMinutes = Math.round((now - lastRunAt.getTime()) / 60000);
    const stale = expectedMaxAgeMinutes !== null && ageMinutes > expectedMaxAgeMinutes;
    const lastRunStatus = r.status as PipelineStatus;
    // Overall status: a stale heartbeat outranks a stale "ok" — if it should have
    // run by now and hasn't, that's a problem even if the last run was clean.
    const status: PipelineHealth['status'] = stale ? 'stale' : lastRunStatus;
    return {
      pipeline, status, lastRunStatus, lastRunAt: lastRunAt.toISOString(),
      ageMinutes, stale, expectedMaxAgeMinutes,
      itemsProcessed: r.items_processed ?? null,
      itemsFailed: r.items_failed ?? null,
      durationMs: r.duration_ms ?? null,
      message: r.message ?? null,
    };
  });
}
