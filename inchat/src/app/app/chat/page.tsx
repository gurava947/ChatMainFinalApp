import Link from 'next/link';

import { Timestamp } from '@/components/chat/timestamp';
import { createRepository, type ConversationRow } from '@/lib/chat/repository';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { createClient } from '@/lib/supabase/server';

export default async function ChatsPage() {
  // A page that reaches for the database before it knows the database exists is
  // how a misconfigured deploy shows a stack instead of the setup instructions.
  if (!isSupabaseConfigured()) {
    return (
      <p className="notice notice-error" role="alert">
        InChat needs its database settings before your chats can load.
      </p>
    );
  }

  const supabase = await createClient();
  const repository = createRepository(supabase);

  let conversations: ConversationRow[];
  try {
    conversations = await repository.listConversations({ limit: 40 });
  } catch {
    return (
      <p className="notice notice-error" role="alert">
        Your chats could not be loaded. Check the connection and open this page again.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <form className="min-w-0 flex-1" method="get" action="/app/chat/search">
          <label className="field">
            <span className="sr-only">Search messages</span>
            <input className="input" name="q" maxLength={64} placeholder="Search your messages" autoComplete="off" />
          </label>
        </form>
        <Link
          href="/app/chat/new"
          aria-label="Create a room or start a chat"
          title="Create a room or start a chat"
          className="chat-create-fab fixed right-4 z-30 grid h-14 w-14 shrink-0 place-items-center rounded-full text-3xl font-light shadow-lg transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
          style={{ bottom: 'calc(76px + env(safe-area-inset-bottom))' }}
        >
          <span aria-hidden="true">+</span>
          <span className="sr-only">Create a room or start a chat</span>
        </Link>
      </div>

      {!conversations.length ? (
        <div className="panel grid gap-3 p-5">
          <h2 className="text-base font-semibold">No conversations yet</h2>
          <p className="text-sm text-[var(--text-dim)]">
            Open your own thread to keep notes, or find someone by username to start a chat.
          </p>
        </div>
      ) : (
        <ul className="grid gap-2">
          {conversations.map((conversation) => {
            const unread = Number(conversation.unread_count);
            const stamp = Date.parse(conversation.last_message_at ?? '');
            const lastMessageAt = Number.isFinite(stamp) ? stamp : null;
            const name =
              conversation.title ??
              conversation.partner_name ??
              (conversation.partner_username ? `@${conversation.partner_username}` : 'Conversation');

            return (
              <li key={conversation.id}>
                <Link
                  href={`/app/chat/${conversation.id}`}
                  className="panel flex items-center gap-3 px-4 py-3 transition-transform hover:translate-x-[2px]"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--accent-soft)] font-semibold">
                    {name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{name}</span>
                    <span className="block truncate text-xs text-[var(--text-dim)]">
                      {conversation.kind === 'self' ? 'Notes' : conversation.kind}
                      {lastMessageAt ? (
                        <>
                          {' · '}
                          <Timestamp epoch={lastMessageAt} style="auto" />
                        </>
                      ) : null}
                      {conversation.muted ? ' · muted' : ''}
                    </span>
                  </span>
                  {unread > 0 ? (
                    <span className="rounded-full bg-[var(--accent)] px-2 py-[2px] text-xs font-bold text-[#04160b]">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
