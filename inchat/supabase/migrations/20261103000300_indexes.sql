-- Indexes sized for the queries the app actually issues: keyset history,
-- full-text search, and the unread sweep over a member's conversations.
--
-- Deliberately absent: indexes whose leftmost column is already the primary key
-- (conversation_members.conversation_id, message_receipts.message_id), and any
-- index no query in the app uses. Every extra index is paid for on each message
-- insert, which is the hottest write path here.

create index messages_history_idx
  on public.messages (conversation_id, created_at desc, id desc);

-- Search is only ever asked for surviving rows, so the GIN index stays small.
create index messages_search_idx
  on public.messages using gin (search_tsv)
  where deleted_at is null;

create index messages_sender_idx
  on public.messages (sender_id, created_at desc);

-- Foreign keys are not indexed automatically. These three exist because a
-- profile deletion cascades or nulls through them, and without an index
-- Postgres has to scan the whole child table while holding the parent lock.
-- Both are partial on purpose: the columns are null on almost every row, and an
-- IS NOT NULL predicate is implied by the equality the cascade performs, so the
-- planner can still use them.
create index conversations_created_by_idx
  on public.conversations (created_by)
  where created_by is not null;

create index messages_deleted_by_idx
  on public.messages (deleted_by)
  where deleted_by is not null;

create index attachments_uploader_idx
  on public.attachments (uploaded_by);

create index conversation_members_user_idx
  on public.conversation_members (user_id);

create index message_receipts_user_idx
  on public.message_receipts (user_id, recorded_at desc);

create index attachments_message_idx
  on public.attachments (message_id);

-- Name lookup for "find a person", over the two columns that are both always
-- present. Username equality is served by the unique index, not this one.
create index profiles_name_search_idx
  on public.profiles using gin (to_tsvector('simple', username || ' ' || full_name));
