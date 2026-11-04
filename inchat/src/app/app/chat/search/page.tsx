import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Timestamp } from '@/components/chat/timestamp';
import { createRepository, type SearchHit } from '@/lib/chat/repository';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const MAX_TERM_LENGTH = 64;

/** The index is word-based, so anything shorter than two characters matches nothing. */
const MIN_TERM_LENGTH = 2;

export default async function MessageSearchPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = '' } = await searchParams;

  if (!isSupabaseConfigured()) {
    return (
      <p className="notice notice-error" role="alert">
        InChat needs its database settings before it can search.
      </p>
    );
  }

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect('/');

  const term = q.trim().slice(0, MAX_TERM_LENGTH);

  let hits: SearchHit[] = [];
  let failed = false;
  if (term.length >= MIN_TERM_LENGTH) {
    try {
      hits = await createRepository(supabase).search(term, 50);
    } catch {
      failed = true;
    }
  }

  return (
    <div className="grid gap-3">
      <Link href="/app/chat" className="text-xs text-[var(--text-dim)] hover:text-[var(--text)]">
        &larr; All chats
      </Link>

      <form className="panel flex items-end gap-2 p-3" method="get" action="/app/chat/search">
        <label className="field min-w-0 flex-1">
          <span className="text-xs text-[var(--text-dim)]">Search your messages</span>
          <input
            className="input"
            name="q"
            defaultValue={term}
            maxLength={MAX_TERM_LENGTH}
            placeholder="A word you remember"
            autoComplete="off"
          />
        </label>
        <button type="submit" className="btn btn-primary text-sm">
          Search
        </button>
      </form>

      {failed ? (
        <p className="notice notice-error" role="alert">
          The search could not reach the database. Try again in a moment.
        </p>
      ) : term.length > 0 && term.length < MIN_TERM_LENGTH ? (
        <p className="notice">Type at least two characters.</p>
      ) : term ? (
        hits.length ? (
          <ul className="grid gap-2">
            {hits.map((hit) => (
              <li key={hit.messageId}>
                <Link href={`/app/chat/${hit.conversationId}`} className="panel grid gap-1 px-4 py-3">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-semibold">{hit.conversationTitle}</span>
                    <span className="truncate text-xs text-[var(--text-dim)]">
                      {hit.senderName}
                      {' · '}
                      <Timestamp epoch={hit.createdAt} style="datetime" />
                    </span>
                  </span>
                  <span className="line-clamp-2 text-sm text-[var(--text-dim)]">
                    {hit.body || `[${hit.kind}]`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="notice">{`No message of yours contains “${term}”. Removed messages are not searched.`}</p>
        )
      ) : (
        <p className="notice">Search finds text you can already read, in every chat you are in.</p>
      )}
    </div>
  );
}
