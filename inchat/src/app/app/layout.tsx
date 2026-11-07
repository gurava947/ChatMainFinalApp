import Link from 'next/link';
import { redirect } from 'next/navigation';

import { InLogo } from '@/components/brand';
import { SupabaseNotice } from '@/components/guest-shell';
import { TabBar } from '@/components/tab-bar';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

type GuestProfile = { full_name: string; username: string; is_profile_setup: boolean };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!isSupabaseConfigured()) {
    return (
      <main className="mx-auto grid min-h-screen w-full max-w-[560px] place-items-center p-5">
        <div className="panel w-full p-4">
          <h1 className="mb-2 text-base font-semibold">InChat needs its database</h1>
          <SupabaseNotice />
        </div>
      </main>
    );
  }

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect('/');

  const [{ data: profileData }, { data: unreadRow }] = await Promise.all([
    supabase
      .from('profiles')
      .select('full_name, username, is_profile_setup')
      .eq('id', user.id)
      .maybeSingle(),
    supabase.rpc('my_unread_total').single<{ my_unread_total: number }>()
  ]);
  const profile = profileData as GuestProfile | null;
  if (!profile?.is_profile_setup) redirect('/');

  const unread = Number(unreadRow?.my_unread_total ?? 0);
  return (
    <div className="flex min-h-screen flex-col">
      <header className="app-topbar sticky top-0 z-20 flex items-center gap-3 px-4 py-3">
        <Link href="/app/chat" className="app-brand-lockup flex shrink-0 items-center gap-2" aria-label="InChat home">
          <span className="tricolour-frame rounded-[13px]"><InLogo size={32} /></span>
          <span className="app-brand-word">INchat</span>
          <span className="india-flag" role="img" aria-label="Indian flag"><i /><i /><i /></span>
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{profile.full_name}</p>
          <p className="truncate text-xs text-[var(--text-dim)]">Guest chat · @{profile.username}</p>
        </div>
        <Link href="/setup" className="btn btn-ghost !px-3 !py-2 text-xs">
          Profile
        </Link>
      </header>
      <main className="mx-auto w-full max-w-[820px] flex-1 px-3 py-4">{children}</main>
      <TabBar unread={unread} />
    </div>
  );
}
