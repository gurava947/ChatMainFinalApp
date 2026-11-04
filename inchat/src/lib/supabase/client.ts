'use client';

import { createBrowserClient } from '@supabase/ssr';

import { supabaseConfig } from './env';

let cached: ReturnType<typeof createBrowserClient> | null = null;

/**
 * One browser client for the whole document.
 *
 * Creating it per component would hand Supabase a second storage reader and a
 * second auth-state listener each time a component re-renders or remounts,
 * which is where duplicate realtime subscriptions and duplicate redirects
 * come from.
 */
export function createClient() {
  if (!cached) {
    const { url, anonKey } = supabaseConfig();
    cached = createBrowserClient(url, anonKey);
  }
  return cached;
}
