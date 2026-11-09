-- Row Level Security.
--
-- RLS is enabled (not forced), so the SECURITY DEFINER functions above read the
-- membership table without being filtered by their own policy; everything a
-- client touches directly is subject to these rules.
--
-- Writes that need to cross a privilege boundary - creating a conversation with
-- other members, recording a receipt for someone else's message, storing a
-- retried send - go through those functions. Direct insert/update/delete on the
-- chat tables is therefore denied to every client role, which is what keeps a
-- forged request from writing into a conversation it was never part of.

alter table public.profiles            enable row level security;
alter table public.conversations       enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages            enable row level security;
alter table public.message_receipts    enable row level security;
alter table public.attachments         enable row level security;
alter table public.user_settings       enable row level security;

-- Nothing here is public; an anonymous request has no rows to see.
revoke all on public.profiles             from anon;
revoke all on public.conversations        from anon;
revoke all on public.conversation_members from anon;
revoke all on public.messages             from anon;
revoke all on public.message_receipts     from anon;
revoke all on public.attachments          from anon;
revoke all on public.user_settings        from anon;

-- ------------------------------------------------------------------ profiles
-- Every signed-in user can read a profile: that is what lets someone find and
-- message another person. Only the owner may write their own.
create policy profiles_select_authenticated
  on public.profiles for select
  to authenticated
  using (true);

-- ...but not the email address. It is copied from auth.users at setup time, and
-- no chat feature looks a person up by it, so leaving it readable would turn
-- registration into an email-harvesting endpoint for every signed-in account.
-- Column privileges are role-wide, which is fine here: the account owner reads
-- their own address from the session, and complete_profile_setup() reads
-- auth.users as the object owner.
revoke select (email) on public.profiles from public, anon, authenticated;

create policy profiles_insert_self
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = id);

create policy profiles_update_self
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy profiles_delete_self
  on public.profiles for delete
  to authenticated
  using ((select auth.uid()) = id);

-- -------------------------------------------------------------- conversations
-- A conversation is readable only by a member. Creation is exclusively through
-- create_direct_conversation / create_group_conversation / ensure_self_conversation.
create policy conversations_select_member
  on public.conversations for select
  to authenticated
  using (public.is_conversation_member(id, (select auth.uid())));

-- ------------------------------------------------------- conversation_members
-- Members see the roster of a conversation they are in; the same definer
-- function that the other policies use breaks the recursion that a direct
-- self-existence check would create.
create policy conversation_members_select_member
  on public.conversation_members for select
  to authenticated
  using (public.is_conversation_member(conversation_id, (select auth.uid())));

-- ------------------------------------------------------------------- messages
create policy messages_select_member
  on public.messages for select
  to authenticated
  using (public.is_conversation_member(conversation_id, (select auth.uid())));

-- ------------------------------------------------------------------- receipts
-- The definer helper does the message -> conversation -> membership walk. An
-- EXISTS over public.messages written here would evaluate that table's own RLS
-- policy as a nested filter on every candidate row.
create policy message_receipts_select_member
  on public.message_receipts for select
  to authenticated
  using (public.is_message_participant(message_id, (select auth.uid())));

-- --------------------------------------------------------------- attachments
create policy attachments_select_member
  on public.attachments for select
  to authenticated
  using (public.is_message_participant(message_id, (select auth.uid())));

-- An uploader may register their own file, and only onto a message they can
-- see. Storage itself is checked separately by the bucket policies.
create policy attachments_insert_self
  on public.attachments for insert
  to authenticated
  with check (
    (select auth.uid()) = uploaded_by
    and exists (
      select 1
      from public.messages m
      where m.id = message_id
        and m.sender_id = (select auth.uid())
        and public.is_conversation_member(m.conversation_id, (select auth.uid()))
    )
  );

-- Removing a file a message points at is the same authority as deleting the
-- message itself: the sender, or an admin of that conversation.
create policy attachments_delete_owner_or_admin
  on public.attachments for delete
  to authenticated
  using (
    exists (
      select 1
      from public.messages m
      where m.id = message_id
        and (
          m.sender_id = (select auth.uid())
          or public.is_conversation_admin(m.conversation_id, (select auth.uid()))
        )
    )
  );

-- ------------------------------------------------------------ user_settings
create policy user_settings_select_self
  on public.user_settings for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy user_settings_insert_self
  on public.user_settings for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy user_settings_update_self
  on public.user_settings for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ------------------------------------------------------------------ function
-- Postgres grants EXECUTE to PUBLIC on every new function, so a function that is
-- never mentioned again is callable by the anonymous role regardless of the
-- table privileges revoked above. This list is the whole public surface: each
-- entry is taken away from public and anon and handed to authenticated only.
-- scripts/check-sql.cjs fails the build if a migration defines a function that
-- is missing here, which is what keeps the list from drifting.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    -- policy helpers
    'public.is_conversation_member(uuid,uuid)',
    'public.is_conversation_admin(uuid,uuid)',
    'public.is_message_participant(uuid,uuid)',
    -- internal helpers
    'public.private_set_updated_at()',
    'public.private_ensure_user_settings()',
    'public.private_touch_conversation_on_message()',
    'public.private_pair_key(uuid,uuid)',
    'public.private_path_conversation(text)',
    'public.private_path_uploader(text)',
    -- entry points the client calls
    'public.complete_profile_setup(text,text,text,text)',
    'public.create_direct_conversation(uuid)',
    'public.create_group_conversation(text,uuid[])',
    'public.ensure_self_conversation()',
    'public.list_my_conversations(integer,timestamptz,uuid)',
    'public.list_messages(uuid,timestamptz,uuid,integer)',
    'public.search_my_messages(text,integer)',
    'public.send_message(uuid,uuid,text,text,jsonb)',
    'public.edit_message(uuid,text)',
    'public.delete_message_for_everyone(uuid)',
    'public.mark_messages_seen(uuid)',
    'public.set_conversation_mute(uuid,timestamptz)',
    'public.my_unread_total()'
  ]
  loop
    -- The storage path helpers live in the storage migration, which runs after
    -- this one; that migration locks them down itself. Skipping anything not
    -- created yet keeps this file applicable in dependency order either way.
    if to_regprocedure(fn) is not null then
      execute format('revoke all on function %s from public, anon', fn);
      execute format('grant execute on function %s to authenticated', fn);
    end if;
  end loop;
end;
$$;
