'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { guestFormErrors, guestProfileSchema, type GuestFormState } from '@/lib/guest/forms';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { createClient } from '@/lib/supabase/server';

function formText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function guestModeMessage(raw: string): string {
  const message = raw.toLowerCase();
  if (message.includes('anonymous') || message.includes('disabled')) {
    return 'Guest chat is not enabled yet. Turn on Anonymous Sign-Ins in your Supabase Auth settings.';
  }
  if (message.includes('rate limit')) return 'Too many guest sessions were started. Wait a moment and try again.';
  return 'Could not start guest chat. Check the Supabase connection and try again.';
}

export async function startGuestChat(_state: GuestFormState, formData: FormData): Promise<GuestFormState> {
  const parsed = guestProfileSchema.safeParse({
    fullName: formText(formData, 'fullName'),
    username: formText(formData, 'username'),
    bio: ''
  });
  if (!parsed.success) return { errors: guestFormErrors(parsed.error) };
  if (!isSupabaseConfigured()) return { message: 'The chat service is not connected yet.' };

  const supabase = await createClient();
  const { data: current } = await supabase.auth.getUser();
  if (!current.user) {
    const { error } = await supabase.auth.signInAnonymously({
      options: { data: { full_name: parsed.data.fullName, guest: true } }
    });
    if (error) return { message: guestModeMessage(error.message) };
  }

  const { error } = await supabase.rpc('complete_profile_setup', {
    p_full_name: parsed.data.fullName,
    p_username: parsed.data.username,
    p_bio: ''
  });
  if (error) {
    if (error.code === '23505') return { errors: { username: 'That username is already taken.' } };
    return { message: 'Could not create your guest profile. Try again.' };
  }

  revalidatePath('/');
  revalidatePath('/app', 'layout');
  redirect('/app/chat');
}

export async function saveGuestProfile(_state: GuestFormState, formData: FormData): Promise<GuestFormState> {
  const parsed = guestProfileSchema.safeParse({
    fullName: formText(formData, 'fullName'),
    username: formText(formData, 'username'),
    bio: formText(formData, 'bio')
  });
  if (!parsed.success) return { errors: guestFormErrors(parsed.error) };
  if (!isSupabaseConfigured()) return { message: 'The chat service is not connected yet.' };

  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect('/');

  const { error } = await supabase.rpc('complete_profile_setup', {
    p_full_name: parsed.data.fullName,
    p_username: parsed.data.username,
    p_bio: parsed.data.bio
  });
  if (error) {
    if (error.code === '23505') return { errors: { username: 'That username is already taken.' } };
    return { message: 'Could not save your profile. Try again.' };
  }

  revalidatePath('/setup');
  revalidatePath('/app', 'layout');
  redirect('/app/chat');
}
