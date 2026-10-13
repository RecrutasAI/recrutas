import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { supabase } from './supabase-client';
import { getCachedProfile, setCachedProfile } from '@/utils/storage.utils';
import { getSignupCode } from './signup-code';

/**
 * Generic API request helper with authentication
 * Handles both JSON and FormData bodies automatically
 */
export async function apiRequest(method: string, url: string, body?: any): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const headers: Record<string, string> = {};

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  // Read by the server only on the request that creates a new account (sign-up attribution).
  const signupCode = getSignupCode();
  if (signupCode) {
    headers['x-invite-code'] = signupCode;
  }

  // Handle FormData (file uploads) vs JSON
  const isFormData = body instanceof FormData;
  if (!isFormData && body) {
    headers['Content-Type'] = 'application/json';
  }
  // Don't set Content-Type for FormData - browser sets it with boundary

  const response = await fetch(url, {
    method,
    headers,
    credentials: 'include',
    body: isFormData ? body : (body ? JSON.stringify(body) : undefined),
  });

  return response;
}

export async function fetchProfileWithCache(): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const res = await fetch('/api/candidate/profile', {
    headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    credentials: 'include',
  });

  if (res.status === 503) {
    // On timeout, use cached profile if available
    const cached = getCachedProfile();
    if (cached) {
      return { ...cached, _fromCache: true };
    }
    throw new Error('Profile temporarily unavailable. Please retry.');
  }

  if (!res.ok) {
    throw new Error(`Profile fetch failed: ${res.status}`);
  }

  const data = await res.json();
  
  // Handle new user response format
  if (data.exists === false) {
    // New user with no profile yet - return null (not an error)
    return null;
  }

  // Existing profile
  const profile = data.profile || data;
  // Ensure skills is always an array to prevent crashes
  const safeProfile = {
    ...profile,
    skills: profile.skills || [],
  };
  setCachedProfile(safeProfile);
  return safeProfile;
}

// Default query function: uses queryKey[0] as the URL, includes Supabase Bearer token
const getQueryFn: <T>(options: { on401: 'returnNull' | 'throw' }) => QueryFunction<T> =
  ({ on401 }) =>
  async ({ queryKey }) => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    const res = await fetch(queryKey[0] as string, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      credentials: 'include',
    });

    if (on401 === 'returnNull' && res.status === 401) {
      return null;
    }

    if (!res.ok) {
      const text = (await res.text()) || res.statusText;
      throw new Error(`${res.status}: ${text}`);
    }

    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: 'returnNull' }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Don't retry 401 errors
        if (error.message.includes('401')) {return false;}
        return failureCount < 3;
      },
    },
    mutations: {
      retry: false,
    },
  },
});