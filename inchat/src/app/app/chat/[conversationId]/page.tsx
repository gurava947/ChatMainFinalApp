import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { Thread, THREAD_PAGE_SIZE } from '@/components/chat/thread';
import type { Receipt } from '@/lib/chat/receipts';
import { createRepository } from '@/lib/chat/repository';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { createClient } from '@/lib/supabase/server';

// A thread belongs to the signed-in request: caching one would serve another
// person's conversation history.
export const dynamic = 'force-dynamic';

type ConversationRecord = {
  id: string;
  kind: 'direct' | 'group' | 'self';
  title: string | null;
};

type MembershipRow = {
  muted_until: string | null;
};

type PeerRow = {
  user_id: string;
  profiles: { full_name: string | null; username: string | null } | null;
};

type ReceiptRow = {
  message_id: string;
  user_id: string;
  state: 'delivered' | 'read';
  recorded_at: string;
};

async function directTitle(
  supabase: Awaited<ReturnType<typeof createClient>>,
  conversationId: string,
  viewerId: string
): Promise<string> {
  const { data } = await supabase
    .from('conversation_members')
    .select('user_id, profiles ( full_name, username )')
    .eq('conversation_id', conversationId)
    .neq('user_id', viewerId)
    .limit(1)
    .maybeSingle();

  const peer = data as PeerRow | null;
  const name = peer?.profiles?.full_name?.trim();
  if (name) return name;
  if (peer?.profiles?.username) return `@${peer.profiles.username}`;
  return 'Conversation';
}

export default async function ConversationPage({
  params
}: {
  params: Promise<{ conversationId: string }>;
}) {
  // The app shell renders the configuration notice and never reaches a page
  // without it; this is the fail-safe so a bypassed shell cannot throw.
  if (!isSupabaseConfigured()) {
    return (
      <p className="notice notice-error" role="alert">
        InChat needs its database settings before a chat can open.
      </p>
    );
  }

  const { conversationId } = await params;
  const supabase = await createClient();

  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect('/');

  // Read under RLS, not through a definer function: a conversation the caller
  // is not a member of simply does not exist for them, which is the answer the
  // page wants - there is nothing here to show.
  const { data: conversationData, error: conversationError } = await supabase
    .from('conversations')
    .select('id, kind, title')
    .eq('id', conversationId)
    .maybeSingle();

  if (conversationError) {
    return (
      <p className="notice notice-error" role="alert">
        This chat could not be opened: {conversationError.message}
      </p>
    );
  }
  if (!conversationData) notFound();

  const conversation = conversationData as ConversationRecord;

  const title =
    conversation.kind === 'self'
      ? 'Notes to yourself'
      : conversation.kind === 'direct'
        ? await directTitle(supabase, conversationId, user.id)
        : (conversation.title ?? 'Group');

  const { data: membershipData } = await supabase
    .from('conversation_members')
    .select('muted_until')
    .eq('conversation_id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();

  const membership = membershipData as MembershipRow | null;
  // Clearing a mute writes NULL, so any value still in the column is a mute the
  // member has not lifted.
  const muted = membership !== null && membership.muted_until !== null && membership.muted_until !== undefined;

  const repository = createRepository(supabase);

  let initial;
  try {
    initial = await repository.listMessages({ conversationId, limit: THREAD_PAGE_SIZE });
  } catch (error) {
    return (
      <p className="notice notice-error" role="alert">
        {error instanceof Error ? error.message : 'The messages in this chat could not be loaded.'}
      </p>
    );
  }

  // Ticks are reloaded with the window: without this, reopening a chat would
  // show every message you sent as merely delivered-to-nobody until the next
  // realtime receipt happened to arrive.
  const { data: receiptData } = await supabase
    .from('message_receipts')
    .select('message_id, user_id, state, recorded_at')
    .in('message_id', initial.map((message) => message.id));

  const initialReceipts: Receipt[] = ((receiptData ?? []) as ReceiptRow[])
    .map((row) => ({
      messageId: row.message_id,
      userId: row.user_id,
      state: row.state,
      recordedAt: Date.parse(row.recorded_at)
    }))
    .filter((receipt) => Number.isFinite(receipt.recordedAt));

  return (
    <div className="grid gap-3">
      <Link href="/app/chat" className="text-xs text-[var(--text-dim)] hover:text-[var(--text)]">
        &larr; All chats
      </Link>
      <Thread
        conversationId={conversationId}
        title={title}
        viewerId={user.id}
        initial={initial}
        initialReceipts={initialReceipts}
        initiallyMuted={muted}
      />
    </div>
  );
}
