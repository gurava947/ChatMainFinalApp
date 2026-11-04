'use strict';

/**
 * Supabase connection settings, read lazily.
 *
 * Reading these at module load would break `next build` on a machine with no
 * project yet: the build evaluates route modules, and a throw there is a build
 * failure rather than a runtime message. Each caller gets a clear error only
 * when it actually tries to reach Supabase.
 */

export type SupabaseConfig = {
  url: string;
  anonKey: string;
};

const MISSING = 'https://YOUR-PROJECT-REF.supabase.co';

export function isPlaceholder(value: string | undefined): boolean {
  return !value || value === MISSING || value.startsWith('your-');
}

export function supabaseConfig(): SupabaseConfig {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const missing = [
    ...(isPlaceholder(url) ? ['NEXT_PUBLIC_SUPABASE_URL'] : []),
    ...(isPlaceholder(anonKey) ? ['NEXT_PUBLIC_SUPABASE_ANON_KEY'] : [])
  ];

  if (missing.length) {
    throw new Error(
      `Supabase is not configured yet: set ${[...new Set(missing)].join(', ')} in inchat/.env.local ` +
        '(copy inchat/.env.example).'
    );
  }

  return { url: url as string, anonKey: anonKey as string };
}

export function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || 'http://localhost:3000';
}

export function isSupabaseConfigured(): boolean {
  try {
    supabaseConfig();
    return true;
  } catch {
    return false;
  }
}
