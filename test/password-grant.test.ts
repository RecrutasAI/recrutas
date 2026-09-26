/**
 * The extension login and the settings "current password" check run server
 * side, where no CAPTCHA can be solved. Supabase Auth skips CAPTCHA only when
 * the request carries admin credentials, so the bearer MUST be the
 * service-role key — if this regresses, turning CAPTCHA on silently breaks
 * extension login for every user.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { passwordGrant } from '../server/lib/password-grant';

const env = { ...process.env };

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://proj.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
});
afterEach(() => {
  process.env = { ...env };
  vi.unstubAllGlobals();
});

describe('passwordGrant', () => {
  it('uses the service-role key as bearer (CAPTCHA-exempt) and returns the session', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await passwordGrant('jane@example.com', 'pw');

    expect(r).toEqual({ ok: true, session: { access_token: 'at', refresh_token: 'rt' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://proj.supabase.co/auth/v1/token?grant_type=password');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer service-role-key');
    expect((init.headers as Record<string, string>).apikey).toBe('anon-key');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'jane@example.com', password: 'pw' });
  });

  it('maps a rejected password to 401 with the Supabase message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error_description: 'Invalid login credentials' }), { status: 400 })));
    expect(await passwordGrant('jane@example.com', 'bad')).toEqual({ ok: false, status: 401, message: 'Invalid login credentials' });
  });

  it('reports misconfiguration instead of calling Supabase', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await passwordGrant('a@b.c', 'pw')).toMatchObject({ ok: false, status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
