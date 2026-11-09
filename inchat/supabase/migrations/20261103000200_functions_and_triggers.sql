-- Functions, triggers and the transactional entry points the app calls.
--
-- These are SECURITY DEFINER with a pinned search_path because they must write
-- rows for other users (conversation membership, receipts for a peer's
-- messages) that the caller could not insert through RLS directly. Each one
-- re-checks authorization itself rather than trusting the caller.

create or replace function public.private_set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated
  before update on public.profiles
  for each row execute function public.private_set_updated_at();

create trigger conversations_touch_updated
  before update on public.conversations
  for each row execute function public.private_set_updated_at();

create trigger user_settings_touch_updated
  before update on public.user_settings
  for each row execute function public.private_set_updated_at();

-- Membership test used by every policy. It has to be SECURITY DEFINER: a policy
-- on conversations that read conversation_members directly would recurse into
-- that table's own policy, which also reads conversation_members.
create or replace function public.is_conversation_member(p_conversation_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.conversation_members m
    where m.conversation_id = p_conversation_id
      and m.user_id = p_user_id
  );
$$;

create or replace function public.is_conversation_admin(p_conversation_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.conversation_members m
    where m.conversation_id = p_conversation_id
      and m.user_id = p_user_id
      and m.role in ('owner', 'admin')
  );
$$;

-- A default settings row must exist for a profile the moment it is complete,
-- otherwise the client has to handle a missing row on every read.
create or replace function public.private_ensure_user_settings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger profiles_after_insert_settings
  after insert on public.profiles
  for each row execute function public.private_ensure_user_settings();

-- Keeps the chat list ordered without a per-row aggregate on read.
create or replace function public.private_touch_conversation_on_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.conversations c
  set last_message_at = new.created_at
  where c.id = new.conversation_id
    and (c.last_message_at is null or c.last_message_at < new.created_at);
  return new;
end;
$$;

create trigger messages_after_insert_touch
  after insert on public.messages
  for each row execute function public.private_touch_conversation_on_message();

-- ------------------------------------------------------------- profile setup
-- Called once after signup and again if the user edits their own identity later.
-- The email is taken from the auth record, never from the request body, so a
-- user cannot claim someone else's address through this path.
create or replace function public.complete_profile_setup(
  p_full_name text,
  p_username text,
  p_bio text default '',
  p_avatar_path text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  handle text := lower(btrim(p_username));
  row public.profiles;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  if handle !~ '^[a-z0-9._]{3,32}$' then
    raise exception 'username must be 3-32 characters of a-z, 0-9, dot or underscore'
      using errcode = '22023';
  end if;

  if char_length(btrim(p_full_name)) < 1 then
    raise exception 'full name is required' using errcode = '22023';
  end if;

  insert into public.profiles (id, username, full_name, email, bio, avatar_path, is_profile_setup)
  values (
    me,
    handle,
    btrim(p_full_name),
    coalesce((select u.email from auth.users u where u.id = me), ''),
    coalesce(btrim(p_bio), ''),
    p_avatar_path,
    true
  )
  on conflict (id) do update
    set username = excluded.username,
        full_name = excluded.full_name,
        bio = excluded.bio,
        avatar_path = excluded.avatar_path,
        is_profile_setup = true
  returning * into row;

  return row;
end;
$$;

-- -------------------------------------------------------------- conversations
-- Sorted pair key: the same two people always produce the same text, which is
-- what lets the unique index collapse repeated "start a chat" clicks into one
-- thread.
create or replace function public.private_pair_key(a uuid, b uuid)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when a::text < b::text then a::text || ':' || b::text
              else b::text || ':' || a::text end;
$$;

-- Receipt and attachment policies need "is this message mine to see", and doing
-- it with an EXISTS over public.messages inside the policy would run that
-- table's own RLS policy as a nested filter. This does the same two index
-- probes once, with no policy recursion.
create or replace function public.is_message_participant(p_message_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.messages m
    join public.conversation_members cm
      on cm.conversation_id = m.conversation_id
     and cm.user_id = p_user_id
    where m.id = p_message_id
  );
$$;

create or replace function public.create_direct_conversation(p_other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  key text;
  found_id uuid;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_other_user_id = me then
    return public.ensure_self_conversation();
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_other_user_id and p.is_profile_setup) then
    raise exception 'that user cannot be messaged yet' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles p where p.id = me and p.is_profile_setup) then
    raise exception 'complete your profile first' using errcode = '22023';
  end if;

  key := public.private_pair_key(me, p_other_user_id);

  insert into public.conversations (kind, direct_key, created_by)
  values ('direct', key, me)
  on conflict (direct_key) do nothing
  returning id into found_id;

  if found_id is null then
    select c.id into found_id from public.conversations c where c.direct_key = key;
  else
    insert into public.conversation_members (conversation_id, user_id, role)
    values (found_id, me, 'owner'), (found_id, p_other_user_id, 'member');
  end if;

  return found_id;
end;
$$;

create or replace function public.ensure_self_conversation()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  found_id uuid;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  insert into public.conversations (kind, self_key, created_by, title)
  values ('self', me::text, me, 'Message Yourself')
  on conflict (self_key) do nothing
  returning id into found_id;

  if found_id is null then
    select c.id into found_id from public.conversations c where c.self_key = me::text;
  else
    insert into public.conversation_members (conversation_id, user_id, role)
    values (found_id, me, 'owner');
  end if;

  return found_id;
end;
$$;

create or replace function public.create_group_conversation(p_title text, p_member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  new_id uuid;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if btrim(p_title) = '' or char_length(btrim(p_title)) > 60 then
    raise exception 'group name must be 1-60 characters' using errcode = '22023';
  end if;
  if coalesce(array_length(p_member_ids, 1), 0) not between 1 and 255 then
    raise exception 'a group needs between 1 and 255 other members' using errcode = '22023';
  end if;

  -- A group is only created if every invitee is a real, set-up profile; a single
  -- typo must not silently drop a member.
  if exists (
    select 1
    from unnest(p_member_ids) as invited(id)
    where not exists (
      select 1 from public.profiles p
      where p.id = invited.id and p.is_profile_setup and p.id <> me
    )
  ) then
    raise exception 'invited user not found' using errcode = '22023';
  end if;

  insert into public.conversations (kind, title, created_by)
  values ('group', btrim(p_title), me)
  returning id into new_id;

  insert into public.conversation_members (conversation_id, user_id, role)
  select new_id, me, 'owner'
  union all
  select new_id, u.id, 'member'
  from public.profiles u
  where u.id = any (p_member_ids);

  return new_id;
end;
$$;

-- ------------------------------------------------------------------- reads
-- Keyset pagination: the cursor is the (sort timestamp, id) of the last row the
-- client already has, so a message arriving mid-scroll cannot shift pages and
-- produce a duplicate or a gap the way an offset would.
create or replace function public.list_my_conversations(
  p_limit integer default 30,
  p_before_sort_at timestamptz default null,
  p_before_id uuid default null
)
returns table (
  id uuid,
  kind text,
  title text,
  avatar_path text,
  partner_id uuid,
  partner_name text,
  partner_username text,
  last_message_at timestamptz,
  sort_at timestamptz,
  unread_count bigint,
  muted boolean,
  role text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- The page is picked first, out of the caller's own memberships, and only the
  -- rows that survive get a partner and an unread count. Evaluating both for
  -- every conversation a user has ever joined would put hundreds of index
  -- probes behind a list that shows thirty rows.
  with page as (
    select c.id, c.kind, c.title, c.avatar_path, c.created_at, c.last_message_at,
           m.role, m.last_read_at, m.muted_until
    from public.conversation_members m
    join public.conversations c on c.id = m.conversation_id
    where m.user_id = (select auth.uid())
      and ((p_before_sort_at is null or p_before_id is null)
           or (coalesce(c.last_message_at, c.created_at), c.id)
              < (p_before_sort_at, p_before_id))
    order by coalesce(c.last_message_at, c.created_at) desc, c.id desc
    limit greatest(1, least(coalesce(p_limit, 30), 100))
  )
  select
    page.id,
    page.kind,
    coalesce(page.title, partner.partner_name) as title,
    page.avatar_path,
    partner.partner_id,
    partner.partner_name,
    partner.partner_username,
    page.last_message_at,
    coalesce(page.last_message_at, page.created_at) as sort_at,
    (
      select count(*)
      from public.messages msg
      where msg.conversation_id = page.id
        and msg.deleted_at is null
        and msg.sender_id <> (select auth.uid())
        and msg.created_at > page.last_read_at
    ) as unread_count,
    (page.muted_until is not null and page.muted_until > now()) as muted,
    page.role
  from page
  left join lateral (
    select p.id as partner_id, p.full_name as partner_name, p.username as partner_username
    from public.conversation_members other
    join public.profiles p on p.id = other.user_id
    where other.conversation_id = page.id
      and p.id <> (select auth.uid())
    order by p.id
    limit 1
  ) partner on true
  order by coalesce(page.last_message_at, page.created_at) desc, page.id desc;
$$;

-- The open thread's history, oldest-first, walking backwards from a cursor.
create or replace function public.list_messages(
  p_conversation_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
)
returns setof public.messages
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- auth.uid() is a STABLE function, so a bare call in a WHERE clause runs once
  -- per row examined. The sub-select form makes it an initplan: one JWT read for
  -- the whole query.
  select msg.*
  from public.messages msg
  where msg.conversation_id = p_conversation_id
    and public.is_conversation_member(p_conversation_id, (select auth.uid()))
    and (p_before_created_at is null or p_before_id is null
         or (msg.created_at, msg.id) < (p_before_created_at, p_before_id))
  order by msg.created_at desc, msg.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

create or replace function public.search_my_messages(p_query text, p_limit integer default 50)
returns table (
  message_id uuid,
  conversation_id uuid,
  conversation_title text,
  sender_id uuid,
  sender_name text,
  body text,
  kind text,
  created_at timestamptz,
  rank real
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    msg.id,
    msg.conversation_id,
    coalesce(c.title, 'Chat') as conversation_title,
    msg.sender_id,
    p.full_name as sender_name,
    left(msg.body, 500) as body,
    msg.kind,
    msg.created_at,
    ts_rank(msg.search_tsv, websearch_to_tsquery('simple', p_query)) as rank
  from public.messages msg
  -- Membership as a join, not a per-row function call: the search can touch
  -- thousands of rows and each one would otherwise pay for its own probe.
  join public.conversation_members cm
    on cm.conversation_id = msg.conversation_id
   and cm.user_id = (select auth.uid())
  join public.conversations c on c.id = msg.conversation_id
  join public.profiles p on p.id = msg.sender_id
  where char_length(btrim(p_query)) >= 2
    and msg.deleted_at is null
    and msg.search_tsv @@ websearch_to_tsquery('simple', p_query)
  order by rank desc, msg.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

-- ------------------------------------------------------------------ writes
-- Idempotent send: a retry from the offline outbox carries the same client_id,
-- hits the unique index, and returns the row that is already stored with
-- duplicate = true instead of failing or storing it twice.
create or replace function public.send_message(
  p_conversation_id uuid,
  p_client_id uuid,
  p_kind text default 'text',
  p_body text default '',
  p_payload jsonb default '{}'::jsonb
)
-- OUT column names must not repeat a table column name: plpgsql then cannot
-- tell the ON CONFLICT target from the variable and refuses to run the insert
-- (42702). The ack fields are prefixed instead of forcing a resolution rule.
returns table (message_id uuid, message_created_at timestamptz, message_sender_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  stored public.messages;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not public.is_conversation_member(p_conversation_id, me) then
    raise exception 'not your conversation' using errcode = '42501';
  end if;
  if p_kind <> 'text' and coalesce(p_payload, '{}'::jsonb) = '{}'::jsonb then
    raise exception 'a % message needs its payload', p_kind using errcode = '22023';
  end if;
  if p_kind = 'text' and btrim(p_body) = '' then
    raise exception 'message is empty' using errcode = '22023';
  end if;

  insert into public.messages (conversation_id, sender_id, kind, body, payload, client_id)
  values (p_conversation_id, me, p_kind, btrim(p_body), coalesce(p_payload, '{}'::jsonb), p_client_id)
  on conflict (conversation_id, sender_id, client_id) do nothing
  returning * into stored;

  if stored is null then
    select m.* into stored
    from public.messages m
    where m.conversation_id = p_conversation_id
      and m.sender_id = me
      and m.client_id = p_client_id;
    return query select stored.id, stored.created_at, stored.sender_id, true;
    return;
  end if;

  return query select stored.id, stored.created_at, stored.sender_id, false;
end;
$$;

create or replace function public.edit_message(p_message_id uuid, p_body text)
returns public.messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  stored public.messages;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  -- Checked here so an over-long or blank edit says so, instead of looking like
  -- a message that does not belong to the caller.
  if char_length(btrim(p_body)) not between 1 and 20000 then
    raise exception 'message body must be 1-20000 characters' using errcode = '22023';
  end if;

  update public.messages m
  set body = btrim(p_body),
      edited_at = now()
  where m.id = p_message_id
    and m.sender_id = me
    and m.kind = 'text'
    and m.deleted_at is null
  returning * into stored;

  if stored is null then
    raise exception 'nothing to edit' using errcode = '22023';
  end if;

  return stored;
end;
$$;

-- Delete for everyone: the content is destroyed for every member, so the body
-- and payload are cleared and the removal travels as an update on this row.
create or replace function public.delete_message_for_everyone(p_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  updated integer;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  update public.messages m
  set deleted_at = now(),
      deleted_by = me,
      body = '',
      payload = jsonb_build_object('deleted', true, 'kind', m.kind)
  where m.id = p_message_id
    and m.deleted_at is null
    and (
      m.sender_id = me
      or public.is_conversation_admin(m.conversation_id, me)
    )
    and m.created_at > now() - interval '24 hours';

  get diagnostics updated = row_count;
  return updated > 0;
end;
$$;

create or replace function public.mark_messages_seen(p_conversation_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  since timestamptz;
  moved integer;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not public.is_conversation_member(p_conversation_id, me) then
    raise exception 'not your conversation' using errcode = '42501';
  end if;

  select cm.last_read_at
  into since
  from public.conversation_members cm
  where cm.conversation_id = p_conversation_id
    and cm.user_id = me;

  -- Receipts are written for the unread window only. Without the lower bound,
  -- every visit to an old thread would re-attempt one insert per message it has
  -- ever held, which grows the receipts table and the transaction lock time
  -- with the history instead of with the new activity.
  insert into public.message_receipts (message_id, user_id, state)
  select m.id, me, 'read'
  from public.messages m
  where m.conversation_id = p_conversation_id
    and m.sender_id <> me
    and m.deleted_at is null
    and m.created_at > since
  on conflict (message_id, user_id, state) do nothing;

  get diagnostics moved = row_count;

  update public.conversation_members cm
  set last_read_at = now()
  where cm.conversation_id = p_conversation_id
    and cm.user_id = me;

  return moved;
end;
$$;

create or replace function public.set_conversation_mute(p_conversation_id uuid, p_until timestamptz)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  moved integer;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  update public.conversation_members cm
  set muted_until = p_until
  where cm.conversation_id = p_conversation_id
    and cm.user_id = me;

  get diagnostics moved = row_count;
  return moved > 0;
end;
$$;

-- Global unread total for the tab badge, derived from the same last_read_at the
-- list uses, so the badge and the list can never disagree.
create or replace function public.my_unread_total()
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- One aggregate over the caller's own memberships. The earlier form ran a
  -- separate count sub-select per conversation, including threads the user has
  -- not opened in months, on every page of the app shell.
  select count(*)
  from public.messages msg
  join public.conversation_members cm
    on cm.conversation_id = msg.conversation_id
   and cm.user_id = (select auth.uid())
  where msg.sender_id <> (select auth.uid())
    and msg.deleted_at is null
    and msg.created_at > cm.last_read_at;
$$;
