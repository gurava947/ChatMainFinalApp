import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { supabaseConfig } from '@/lib/supabase/env';

/** Keep an existing guest session fresh; room authorization remains enforced by RLS. */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  let supabase;
  try {
    const { url, anonKey } = supabaseConfig();
    supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        }
      }
    });
  } catch {
    // No project configured: let the pages render their own setup message
    // instead of turning every route into a server error.
    return response;
  }

  try {
    await supabase.auth.getUser();
  } catch {
    // Leave the guest entry page available during a temporary auth outage.
  }
  return response;
}

export const config = {
  // Static assets and the Next internals stay untouched.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)']
};
