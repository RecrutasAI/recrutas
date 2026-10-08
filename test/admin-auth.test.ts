import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { adminEmails, adminEmailFromSession, verifyAdminSecret } from '../server/middleware/security';

const SECRET = 'test-jwt-secret';
const token = (email: string, key = SECRET) => jwt.sign({ sub: 'u1', email }, key, { algorithm: 'HS256', expiresIn: '1h' });
const req = (headers: Record<string, string>) => ({ headers } as any);
const res = () => { const r: any = { code: 0 }; r.status = (c: number) => { r.code = c; return r; }; r.json = () => r; return r; };

describe('admin access', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = SECRET;
    process.env.ADMIN_EMAILS = 'Founder@Recrutas.ai, ops@recrutas.ai';
    process.env.ADMIN_SECRET = 'script-secret';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('reads the admin list case-insensitively', () => {
    expect([...adminEmails()]).toEqual(['founder@recrutas.ai', 'ops@recrutas.ai']);
  });

  it('lets an ADMIN_EMAILS account in with its normal sign-in', () => {
    const r = req({ authorization: `Bearer ${token('founder@recrutas.ai')}` });
    expect(adminEmailFromSession(r)).toBe('founder@recrutas.ai');
    expect(verifyAdminSecret(r, res())).toBe(true);
  });

  it('turns away a signed-in user who is not an admin', () => {
    const out = res();
    expect(verifyAdminSecret(req({ authorization: `Bearer ${token('someone@gmail.com')}` }), out)).toBe(false);
    expect(out.code).toBe(401);
  });

  it('rejects a token signed with the wrong key', () => {
    expect(adminEmailFromSession(req({ authorization: `Bearer ${token('founder@recrutas.ai', 'forged')}` }))).toBeNull();
  });

  it('still accepts the script secret, and rejects a wrong one', () => {
    expect(verifyAdminSecret(req({ 'x-admin-secret': 'script-secret' }), res())).toBe(true);
    const out = res();
    expect(verifyAdminSecret(req({ 'x-admin-secret': 'nope' }), out)).toBe(false);
    expect(out.code).toBe(401);
  });

  it('rejects a request with no credentials', () => {
    expect(verifyAdminSecret(req({}), res())).toBe(false);
  });
});
