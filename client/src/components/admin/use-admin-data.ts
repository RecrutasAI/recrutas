import { useCallback, useEffect, useState } from 'react';
import { adminFetch } from '@/lib/admin-fetch';

/** GET an admin endpoint; keeps the last good data while refreshing (no skeleton flash). */
export function useAdminData<T>(url: string, refreshMs = 5 * 60_000) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminFetch(url);
      if (!r.ok) {throw new Error(r.status === 401 ? 'Your admin session ended. Sign in again.' : `Couldn't load this (${r.status}).`);}
      setData(await r.json()); setError(null);
    } catch (e: any) {
      setError(e.message || 'Couldn\'t load this.');
    } finally {
      setLoading(false);
    }
  }, [url]);
  useEffect(() => { load(); const t = setInterval(load, refreshMs); return () => clearInterval(t); }, [load, refreshMs]);
  return { data, loading, error, load };
}
