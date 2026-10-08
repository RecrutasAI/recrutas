/**
 * Admin console API: the Today overview, live switches and the audit log.
 * Every route needs an admin (ADMIN_EMAILS session, or the admin secret for scripts).
 * Switch changes require a reason and are written to admin_audit_log with the admin's email.
 */
import type { Express, Request } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { adminEmailFromSession, verifyAdminSecret } from '../middleware/security';
import { getOverview } from '../services/admin-console.service';
import {
  SETTING_DEFAULTS, SETTING_LABELS, isSettingKey, listSettings, recentAudit, setSetting,
} from '../services/runtime-settings.service';

// The secret is for scripts; it has no person behind it, so changes made with it say so.
const actorOf = (req: Request) => adminEmailFromSession(req) ?? 'admin-secret';

export function registerAdminConsoleRoutes(app: Express): void {
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
