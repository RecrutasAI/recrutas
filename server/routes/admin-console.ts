/**
 * Admin console API: the Today overview, live switches, run-now jobs, snoozes and the audit log.
 * Every route needs an admin (ADMIN_EMAILS session, or the admin secret for scripts).
 * Switch changes require a reason and are written to admin_audit_log with the admin's email.
 */
import type { Express, Request } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { adminEmailFromSession, verifyAdminSecret } from '../middleware/security';
import { getOverview } from '../services/admin-console.service';
import { requestJob, snoozeSignal, clearSnooze, isRunnableJob } from '../services/admin-actions.service';
import { getGrowth, getGrowthAnalytics, getJobsInsights, getAiInsights } from '../services/admin-insights.service';
import {
  SETTING_DEFAULTS, SETTING_LABELS, getSettings, isSettingKey, listSettings, recentAudit, setSetting,
} from '../services/runtime-settings.service';

// The secret is for scripts; it has no person behind it, so changes made with it say so.
const actorOf = (req: Request) => adminEmailFromSession(req) ?? 'admin-secret';

export function registerAdminConsoleRoutes(app: Express): void {
  // Public: what every visitor's browser needs from the switches (notice banner,
  // sign-up waitlist). Edge-cached for a minute; getSettings never throws.
  app.get('/api/site/status', asyncHandler(async (_req, res) => {
    const s = await getSettings();
    res.set('Cache-Control', 'public, max-age=30, s-maxage=60');
    res.json({ notice: s.noticeBanner, signupWaitlist: s.signupWaitlist });
  }));

  app.get('/api/admin/console/overview', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) {return;}
    res.set('Cache-Control', 'no-store');
    res.json(await getOverview());
  }));

  app.get('/api/admin/settings', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) {return;}
    let settings;
    try {
      settings = await listSettings();
    } catch {
      // The runtime_settings table isn't migrated yet: show the defaults, read-only.
      return res.json({
        available: false,
        settings: Object.entries(SETTING_DEFAULTS).map(([key, value]) => ({ key, value, pinned: false, updatedBy: null, updatedAt: null, reason: null, ...SETTING_LABELS[key as keyof typeof SETTING_LABELS] })),
      });
    }
    res.json({ available: true, settings: settings.map(s => ({ ...s, ...SETTING_LABELS[s.key] })) });
  }));

  app.put('/api/admin/settings/:key', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) {return;}
    const { key } = req.params;
    if (!isSettingKey(key)) {return res.status(404).json({ message: `Unknown setting: ${key}` });}
    const { value, reason, pinned } = req.body || {};
    if (typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ message: 'Add a short reason. It goes in the audit log.' });
    }
    if (pinned !== undefined && typeof pinned !== 'boolean') {
      return res.status(400).json({ message: 'pinned must be true or false.' });
    }
    const result = await setSetting(key, value, actorOf(req), reason.trim().slice(0, 500), { pinned });
    if (!result.ok) {return res.status(400).json({ message: result.error });}
    res.json({ ok: true });
  }));

  // Growth, Jobs and AI & matching tabs.
  app.get('/api/admin/console/growth', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) {return;}
    res.set('Cache-Control', 'no-store');
    res.json(await getGrowth());
  }));
  app.get('/api/admin/console/growth/analytics', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) {return;}
    res.set('Cache-Control', 'no-store');
    res.json(await getGrowthAnalytics());
  }));
  app.get('/api/admin/console/jobs', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) {return;}
    res.set('Cache-Control', 'no-store');
    res.json(await getJobsInsights());
  }));
  app.get('/api/admin/console/ai', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) {return;}
    res.set('Cache-Control', 'no-store');
    res.json(await getAiInsights());
  }));

  // "Run now": queues a whitelisted job; the VPS starts it within a minute.
  app.post('/api/admin/jobs/:job/run', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) {return;}
    const { job } = req.params;
    if (!isRunnableJob(job)) {return res.status(404).json({ message: `Unknown job: ${job}` });}
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    let result;
    try {
      result = await requestJob(job, actorOf(req), reason);
    } catch {
      return res.status(503).json({ message: 'Run-now is not available until the admin_job_requests migration runs.' });
    }
    if (!result.ok) {return res.status(409).json({ message: result.error });}
    res.json({ ok: true, request: result.request });
  }));

  app.post('/api/admin/signals/:key/snooze', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) {return;}
    const hours = Number(req.body?.hours);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    const result = await snoozeSignal(req.params.key, hours, actorOf(req), reason);
    if (!result.ok) {return res.status(400).json({ message: result.error });}
    res.json({ ok: true });
  }));

  app.delete('/api/admin/signals/:key/snooze', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) {return;}
    await clearSnooze(req.params.key, actorOf(req));
    res.json({ ok: true });
  }));

  app.get('/api/admin/audit', asyncHandler(async (req, res) => {
    if (!verifyAdminSecret(req, res)) {return;}
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    try {
      res.json({ available: true, entries: await recentAudit(limit) });
    } catch {
      res.json({ available: false, entries: [] });
    }
  }));
}
