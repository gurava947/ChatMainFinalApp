import { redirect } from 'next/navigation';

import { GuestEntryForm } from '@/components/guest-forms';
import { GuestShell } from '@/components/guest-shell';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function RootPage() {
  if (!isSupabaseConfigured()) {
    return (
      <GuestShell title="Join InChat" subtitle="Room-based chat. No login required.">
        <p className="text-sm text-[var(--text-dim)]">Connect Supabase to start guest chats. No email or password is needed.</p>
      </GuestShell>
    );
  }

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_profile_setup')
      .eq('id', user.id)
      .maybeSingle();
    if (profile?.is_profile_setup) redirect('/app/chat');
  }

  return (
    <GuestShell title="Join InChat" subtitle="Start a room-based chat in seconds.">
      <GuestEntryForm />
    </GuestShell>
  );
}
