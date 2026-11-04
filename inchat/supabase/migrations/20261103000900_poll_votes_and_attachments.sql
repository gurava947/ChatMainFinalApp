-- Poll votes and the media receipt for a sent file.
--
-- Neither can be a client write: the messages table deliberately has no insert,
-- update or delete policy, so every change to a stored message is a function that
-- decides who may make it.

-- A vote is recorded in a map keyed by voter, so the tally is derived rather
-- than accumulated. That is what makes the operation idempotent: a broadcast
-- that arrives twice, or a member tapping the same option again, cannot inflate
-- a count, and moving a vote is one write.
create or replace function public.vote_in_poll(p_message_id uuid, p_choice integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  msg public.messages;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  select * into msg from public.messages where id = p_message_id;
  if not found then
    raise exception 'no such message' using errcode = 'P0001';
  end if;

  if msg.kind <> 'poll' or jsonb_typeof(msg.payload -> 'options') <> 'array' then
    raise exception 'that message is not a poll' using errcode = '22023';
  end if;

  if not public.is_conversation_member(msg.conversation_id, me) then
    raise exception 'not your conversation' using errcode = '42501';
  end if;

  -- A removed or closed poll answers "no" instead of raising: the row the voter
  -- was looking at is simply stale, and the client re-reads it.
  if msg.deleted_at is not null or coalesce(msg.payload ->> 'closed', 'false') = 'true' then
    return false;
  end if;

  if p_choice is null
     or p_choice < 0
     or p_choice >= jsonb_array_length(msg.payload -> 'options') then
    raise exception 'no such choice' using errcode = '22023';
  end if;

  update public.messages m
  set payload = jsonb_set(
        m.payload,
        '{voters}',
        coalesce(m.payload -> 'voters', '{}'::jsonb) || jsonb_build_object(me::text, p_choice)
      )
  where m.id = p_message_id;

  return found;
end;
$$;

-- The bytes land in Storage before the message exists, so the attachment row is
-- filed afterwards, against the message id the send returned.
--
-- The object path is checked, not trusted: its first segment must be the
-- conversation this message lives in and its second must be the caller, or a
-- file from somebody else's chat could be presented as one of ours.
create or replace function public.register_message_attachment(
  p_message_id uuid,
  p_storage_path text,
  p_kind text,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_width integer,
  p_height integer,
  p_duration_secs numeric
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  msg public.messages;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  select * into msg from public.messages where id = p_message_id;
  if not found then
    raise exception 'no such message' using errcode = 'P0001';
  end if;

  if msg.sender_id <> me then
    raise exception 'not your message' using errcode = '42501';
  end if;

  if public.private_path_conversation(p_storage_path) is distinct from msg.conversation_id then
    raise exception 'that file is not from this conversation' using errcode = '42501';
  end if;

  if public.private_path_uploader(p_storage_path) is distinct from me then
    raise exception 'that file was not uploaded by you' using errcode = '42501';
  end if;

  insert into public.attachments (
    message_id, uploaded_by, storage_path, kind, file_name, mime_type, size_bytes,
    width, height, duration_secs
  )
  values (
    p_message_id, me, p_storage_path, p_kind, btrim(p_file_name), p_mime_type, p_size_bytes,
    p_width, p_height, p_duration_secs
  )
  on conflict (storage_path) do nothing;

  return true;
end;
$$;

revoke all on function public.vote_in_poll(uuid,integer) from public, anon;
grant execute on function public.vote_in_poll(uuid,integer) to authenticated;

revoke all on function public.register_message_attachment(uuid,text,text,text,text,bigint,integer,integer,numeric)
  from public, anon;
grant execute on function public.register_message_attachment(uuid,text,text,text,text,bigint,integer,integer,numeric)
  to authenticated;
