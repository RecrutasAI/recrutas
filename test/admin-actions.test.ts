/**
 * "Run now" from the admin console. The VPS runs a job by looking its command
 * up in RUNNABLE_JOBS, so each entry must match how cron runs that job.
 */
import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { RUNNABLE_JOBS, isRunnableJob, jobForPipeline } from '../server/services/admin-actions.service';

const crontab = readFileSync('infra/vps/crontab', 'utf8').split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));

describe('runnable jobs', () => {
  it.each(Object.entries(RUNNABLE_JOBS))('%s runs exactly as cron runs it', (key, job) => {
    const line = crontab.find(l => new RegExp(`\\$RUN ${key} \\d+ `).test(l));
    expect(line, `no crontab line for ${key}`).toBeTruthy();
    const [, timeout, command] = line!.match(new RegExp(`\\$RUN ${key} (\\d+) (.+)$`))!;
    expect(Number(timeout)).toBe(job.timeoutMin);
    expect(command.trim()).toBe(job.command.join(' '));
    for (const [k, v] of Object.entries('env' in job ? job.env : {})) {expect(line).toContain(`${k}=${v}`);}
  });

  it('never includes jobs that are unsafe to run twice', () => {
    for (const unsafe of ['db-backup', 'vps-db-backup', 'offsite-backup', 'storage-backup', 'pgbackrest-full', 'pgbackrest-incr',
      'purge-old-jobs', 'application-alerts', 'verify-restore', 'autopilot']) {
      expect(isRunnableJob(unsafe)).toBe(false);
    }
  });

  it('maps pipeline names back to their job', () => {
    expect(jobForPipeline('scrape-ats')).toBe('scrape-ats-jobs');
    expect(jobForPipeline('batch-embeddings')).toBe('batch-embeddings');
    expect(jobForPipeline('db-backup')).toBeNull();
  });

  it('rejects names that are not on the list (including look-alikes)', () => {
    for (const bad of ['', 'toString', '__proto__', 'batch-embeddings; rm -rf /', 'BATCH-EMBEDDINGS']) {expect(isRunnableJob(bad)).toBe(false);}
  });
});
