import Link from 'next/link';
import { redirect } from 'next/navigation';

import { createGroupChat, openDirectChat, openSelfChat } from '@/lib/chat/actions';
import { createRepository, type Person } from '@/lib/chat/repository';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/** The action redirects here; the reason is what the user gets to read. */
const ERROR_COPY: Record<string, string> = {
  cannot_open: 'That chat could not be opened. The other person may still be setting up their profile.',
  self_unavailable: 'Your notes thread could not be opened. Try once more.'
};

const MAX_TERM_LENGTH = 64;

export default async function NewChatPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; error?: string }>;
}) {
  const { q = '', error } = await searchParams;

  if (!isSupabaseConfigured()) {
    return (
      <p className="notice notice-error" role="alert">
        InChat needs its database settings before a chat can start.
      </p>
    );
  }

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect('/');

  const term = q.trim().slice(0, MAX_TERM_LENGTH);
  let people: Person[] = [];
  let searchFailed = false;

  if (term) {
    try {
      people = await createRepository(supabase).findPeople(term);
    } catch {
      searchFailed = true;
    }
  }

  const notice = error ? ERROR_COPY[error] : undefined;

  return (
    <div className="grid gap-4">
      <Link href="/app/chat" className="text-xs text-[var(--text-dim)] hover:text-[var(--text)]">
        &larr; All chats
      </Link>

      <div className="grid gap-1">
        <h2 className="text-base font-semibold">Start a chat or create a room</h2>
        <p className="text-sm text-[var(--text-dim)]">Search people to start a private chat or invite members into a named room.</p>
      </div>

      {notice ? (
        <p className="notice notice-error" role="alert">
          {notice}
        </p>
      ) : null}

      <form className="panel flex items-end gap-2 p-3" method="get" action="/app/chat/new">
        <label className="field min-w-0 flex-1">
          <span className="text-xs text-[var(--text-dim)]">Name or @username</span>
          <input
            className="input"
            name="q"
            defaultValue={term}
            maxLength={MAX_TERM_LENGTH}
            placeholder="Search the people already on InChat"
            autoComplete="off"
          />
        </label>
        <button type="submit" className="btn btn-primary text-sm">
          Search
        </button>
      </form>

      {searchFailed ? (
        <p className="notice notice-error" role="alert">
          The search could not reach the database. Try again in a moment.
        </p>
      ) : null}

      {term && !searchFailed ? (
        people.length ? (
          <section className="panel grid gap-3 p-3">
            <h3 className="text-sm font-semibold">{`People matching “${term}”`}</h3>

            <ul className="grid gap-2">
              {people.map((person) => (
                <li key={person.id} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{person.name}</span>
                    <span className="block truncate text-xs text-[var(--text-dim)]">
                      {`@${person.handle}`}
                    </span>
                  </span>
                  <form action={openDirectChat}>
                    <input type="hidden" name="user_id" value={person.id} />
                    <button type="submit" className="btn btn-ghost !px-3 !py-2 text-xs">
                      Message
                    </button>
                  </form>
                </li>
              ))}
            </ul>

            <form className="grid gap-2 border-t border-[var(--line)] pt-3" action={createGroupChat}>
              <div className="grid gap-1">
                <h3 className="text-sm font-semibold">Create a room</h3>
                <p className="text-xs text-[var(--text-dim)]">Name the room and choose its members. It opens as a chat as soon as it is created.</p>
              </div>
              <label className="field">
                <span className="text-xs text-[var(--text-dim)]">Room name</span>
                <input
                  className="input"
                  name="title"
                  required
                  maxLength={60}
                  placeholder="Weekend plans"
                />
              </label>
              <fieldset className="grid gap-1">
                <legend className="text-xs text-[var(--text-dim)]">Members</legend>
                {people.map((person) => (
                  <label key={person.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="member_ids" value={person.id} />
                    <span className="truncate">{`${person.name} · @${person.handle}`}</span>
                  </label>
                ))}
              </fieldset>
              <button type="submit" className="btn btn-primary self-start text-sm">
                Create room
              </button>
            </form>
          </section>
        ) : (
          <p className="notice">
            {`Nobody on InChat matches “${term}”. Usernames are exact words, so try a shorter one.`}
          </p>
        )
      ) : null}

      <section className="panel grid gap-2 p-3">
        <h3 className="text-sm font-semibold">Notes</h3>
        <p className="text-xs text-[var(--text-dim)]">
          A thread only you are in, for the things you would otherwise send to yourself.
        </p>
        <form action={openSelfChat}>
          <button type="submit" className="btn btn-ghost text-sm">
            Message yourself
          </button>
        </form>
      </section>
    </div>
  );
}
