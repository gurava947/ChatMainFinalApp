-- The delivered receipt.
--
-- messages.state 'delivered' exists in the schema, and the tick the user sees
-- depends on it, but nothing wrote it: mark_messages_seen records 'read' only.
-- A client that has the message on screen and acknowledged receiving it is the
-- only witness to its own delivery, so the confirmation arrives here as a batch
-- of ids the client actually holds. The caller is checked for membership before
-- any row is written, and the id list is bounded so one request cannot turn into
-- a full-table scan of the thread.

create or replace function public.mark_messages_delivered(
  p_conversation_id uuid,
  p_message_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := (select auth.uid());
  moved integer;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not public.is_conversation_member(p_conversation_id, me) then
    raise exception 'not your conversation' using errcode = '42501';
  end if;
  if coalesce(array_length(p_message_ids, 1), 0) > 100 then
    raise exception 'a delivery report carries at most 100 messages' using errcode = '22023';
  end if;

  insert into public.message_receipts (message_id, user_id, state)
  select m.id, me, 'delivered'
  from public.messages m
  where m.conversation_id = p_conversation_id
    and m.id = any (p_message_ids)
    and m.sender_id <> me
    and m.deleted_at is null
  on conflict (message_id, user_id, state) do nothing;

  get diagnostics moved = row_count;
  return moved;
end;
$$;

-- Same privilege treatment as the other entry points: no anonymous call, and
-- the signature is listed exactly as the privilege gate reads it.
revoke all on function public.mark_messages_delivered(uuid,uuid[]) from public, anon;
grant execute on function public.mark_messages_delivered(uuid,uuid[]) to authenticated;
