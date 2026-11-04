import { redirect } from 'next/navigation';

import { GuestProfileForm } from '@/components/guest-forms';
import { GuestShell } from '@/components/guest-shell';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { createClient } from '@/lib/supabase/server';

export const metadata = { title: 'Guest profile · InChat' };
export const dynamic = 'force-dynamic';

type GuestProfile = { full_name: string; username: string; bio: string };

export default async function SetupPage() {
  if (!isSupabaseConfigured()) {
    return (
      <GuestShell title="Guest profile" subtitle="Your display name for room chats.">
        <p className="text-sm text-[var(--text-dim)]">Connect the chat database before editing a guest profile.</p>
      </GuestShell>
    );
  }

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect('/');

  const { data } = await supabase
    .from('profiles')
    .select('full_name, username, bio')
    .eq('id', user.id)
    .maybeSingle();
  const profile = data as GuestProfile | null;
  const suggestion = String(user.user_metadata?.full_name ?? user.email?.split('@')[0] ?? 'Guest');
  const handleSuggestion = suggestion.toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 32).padEnd(3, '0');

  return (
    <GuestShell title="Your guest profile" subtitle="Your display name and username appear in rooms.">
      <GuestProfileForm
        fullName={profile?.full_name ?? suggestion}
        username={profile?.username ?? handleSuggestion}
        bio={profile?.bio ?? ''}
      />
    </GuestShell>
  );
}
