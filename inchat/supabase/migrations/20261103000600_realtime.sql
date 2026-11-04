-- Realtime: the chat tables are published so clients can subscribe to
-- postgres_changes. Subscribers only receive rows their RLS policies allow, so
-- a listener on a conversation id cannot see another conversation's inserts.
--
-- Typing and online presence are ephemeral and deliberately not stored: they
-- ride on Realtime Presence, which is why there is no Redis in this stack.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'messages',
    'message_receipts',
    'conversations',
    'attachments'
  ]
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
