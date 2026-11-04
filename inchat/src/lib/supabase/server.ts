import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

import { supabaseConfig } from './env';

/**
 * Server-side Supabase client bound to the request cookies.
 *
 * Cookie-based sessions (rather than localStorage) are what let the middleware
 * know who is calling, and the setAll write is wrapped because a Server
 * Component cannot set a cookie: the middleware has already refreshed the
 * token on the way in, and swallowing this specific failure is what keeps a
 * token refresh from turning a page render into a 500.
 */
export async function createClient() {
  const { url, anonKey } = supabaseConfig();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component: read-only, and the middleware has
          // already persisted the refreshed session.
        }
      }
    }
  });
}
