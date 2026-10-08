/**
 * Admin console routes: only admins get in, switch changes need a reason and a
 * real setting, and the audit log records the admin's email (or 'admin-secret').
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const setSetting = vi.fn(async () => ({ ok: true as const }));
vi.mock('../server/services/admin-console.service', () => ({ getOverview: vi.fn(async () => ({ level: 'green', signals: [] })) }));
vi.mock('../server/services/runtime-settings.service', async (orig) => {
  const real: any = await orig();
  return { ...real, setSetting, listSettings: vi.fn(async () => { throw new Error('relation "runtime_settings" does not exist'); }), recentAudit: vi.fn(async () => []) };
});

const { registerAdminConsoleRoutes } = await import('../server/routes/admin-console');
const app = express(); app.use(express.json()); registerAdminConsoleRoutes(app);
const SECRET = 'test-jwt-secret';
const bearer = (email: string) => `Bearer ${jwt.sign({ sub: 'u1', email }, SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;

describe('admin console routes', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = SECRET; process.env.ADMIN_EMAILS = 'founder@recrutas.ai'; process.env.ADMIN_SECRET = 'script-secret';
    setSetting.mockClear();
  });
  afterEach(() => { process.env = { ...saved }; });

  it('turns away anyone who is not an admin', async () => {
    for (const path of ['/api/admin/console/overview', '/api/admin/settings', '/api/admin/audit']) {
      expect((await request(app).get(path)).status).toBe(401);
      expect((await request(app).get(path).set('authorization', bearer('someone@gmail.com'))).status).toBe(401);
    }
    expect((await request(app).put('/api/admin/settings/signupWaitlist').send({ value: true, reason: 'x' })).status).toBe(401);
  });

  it('serves the overview to an admin, uncached', async () => {
    const r = await request(app).get('/api/admin/console/overview').set('authorization', bearer('founder@recrutas.ai'));
    expect(r.status).toBe(200);
    expect(r.body.level).toBe('green');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('shows read-only defaults when the settings table is not migrated yet', async () => {
    const r = await request(app).get('/api/admin/settings').set('authorization', bearer('founder@recrutas.ai'));
    expect(r.body.available).toBe(false);
    expect(r.body.settings.find((s: any) => s.key === 'signupWaitlist')).toMatchObject({ value: false, title: 'Sign-up waitlist' });
  });

  it('requires a reason and a known setting', async () => {
    const auth = bearer('founder@recrutas.ai');
    expect((await request(app).put('/api/admin/settings/signupWaitlist').set('authorization', auth).send({ value: true })).status).toBe(400);
    expect((await request(app).put('/api/admin/settings/signupWaitlist').set('authorization', auth).send({ value: true, reason: '   ' })).status).toBe(400);
    expect((await request(app).put('/api/admin/settings/deleteEverything').set('authorization', auth).send({ value: true, reason: 'x' })).status).toBe(404);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('records the admin email as the actor, or admin-secret for scripts', async () => {
    await request(app).put('/api/admin/settings/signupWaitlist').set('authorization', bearer('founder@recrutas.ai')).send({ value: true, reason: 'launch spike', pinned: true });
    expect(setSetting).toHaveBeenLastCalledWith('signupWaitlist', true, 'founder@recrutas.ai', 'launch spike', { pinned: true });
    await request(app).put('/api/admin/settings/signupWaitlist').set('x-admin-secret', 'script-secret').send({ value: false, reason: 'over' });
    expect(setSetting).toHaveBeenLastCalledWith('signupWaitlist', false, 'admin-secret', 'over', { pinned: undefined });
  });
});
