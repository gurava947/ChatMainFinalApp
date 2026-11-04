-- InChat core schema: identity, conversations, messages, receipts, media, settings.
-- PostgreSQL is the source of truth; Supabase Auth owns credentials in auth.users,
-- so no password or token column is duplicated here.

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ---------------------------------------------------------------- profiles
-- One row per authenticated user, keyed by the Supabase auth user id.
create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  username           citext not null,
  full_name          text   not null,
  email              citext not null,
  avatar_path        text,
  bio                text not null default '',
  is_profile_setup   boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint profiles_username_length check (char_length(username) between 3 and 32),
  constraint profiles_fullname_length check (char_length(btrim(full_name)) between 1 and 80),
  constraint profiles_bio_length      check (char_length(bio) <= 200)
);

-- Case-insensitive uniqueness is what citext gives us; the index makes the
-- lookup on the login and mention-search paths cheap as well as unique.
create unique index profiles_username_key on public.profiles (username);

-- ---------------------------------------------------------- conversations
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('direct', 'group', 'self')),
  title           text,
  avatar_path     text,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_message_at timestamptz,
  direct_key      text,
  self_key        text,
  constraint conversations_title_length check (title is null or char_length(btrim(title)) between 1 and 60),
  constraint conversations_direct_key_shape
    check (direct_key is null or direct_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- The "Message Yourself" thread is private to exactly one user, so its key is
  -- that user's id and it is unique across the table.
  constraint conversations_self_key_shape
    check (self_key is null or self_key ~ '^[0-9a-f-]{36}$'),
  constraint conversations_kind_keys check (
    (kind = 'direct' and direct_key is not null and self_key is null)
    or (kind = 'self' and self_key is not null and direct_key is null)
    or (kind = 'group'  and direct_key is null and self_key is null)
  )
);

-- A generated column cannot read another table, so the pair identity is written
-- by create_direct_conversation() from the two member ids in sorted order. The
-- unique index is what actually prevents a second thread for the same pair.
create unique index conversations_direct_key_key
  on public.conversations (direct_key);

create unique index conversations_self_key_key
  on public.conversations (self_key);

create index conversations_last_message_idx
  on public.conversations (last_message_at desc nulls last, id);

-- ------------------------------------------------------ conversation_members
create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  role            text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz not null default now(),
  muted_until     timestamptz,
  primary key (conversation_id, user_id)
);

-- ---------------------------------------------------------------- messages
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null references public.profiles (id) on delete cascade,
  kind            text not null default 'text'
                    check (kind in ('text', 'poll', 'location', 'contact', 'event', 'voice', 'image', 'video', 'file')),
  body            text not null default '',
  payload         jsonb not null default '{}'::jsonb,
  -- Client-generated id kept so a retried send is stored once. Unique per
  -- sender: another user cannot collide with or consume someone else's token.
  client_id       uuid not null,
  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,
  deleted_by      uuid references public.profiles (id) on delete set null,
  search_tsv      tsvector generated always as (
                    to_tsvector('simple', coalesce(body, '') || ' ' || coalesce(payload->>'question', ''))
                  ) stored,
  constraint messages_body_length check (char_length(body) <= 20000),
  constraint messages_text_has_body check (kind <> 'text' or char_length(btrim(body)) > 0),
  constraint messages_payload_shape check (jsonb_typeof(payload) = 'object')
);

create unique index messages_client_token_key
  on public.messages (conversation_id, sender_id, client_id);

-- --------------------------------------------------------- message_receipts
create table public.message_receipts (
  message_id   uuid not null references public.messages (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  state        text not null check (state in ('delivered', 'read')),
  recorded_at  timestamptz not null default now(),
  primary key (message_id, user_id, state)
);

-- ------------------------------------------------------------ attachments
-- Only the object path is stored; bytes live in Supabase Storage.
create table public.attachments (
  id             uuid primary key default gen_random_uuid(),
  message_id     uuid not null references public.messages (id) on delete cascade,
  uploaded_by    uuid not null references public.profiles (id) on delete cascade,
  storage_path   text not null,
  kind           text not null check (kind in ('image', 'video', 'audio', 'file')),
  file_name      text not null,
  mime_type      text not null,
  size_bytes     bigint not null check (size_bytes between 1 and 104857600),
  width          integer,
  height         integer,
  duration_secs  numeric,
  created_at     timestamptz not null default now(),
  constraint attachments_path_unique unique (storage_path),
  constraint attachments_name_length check (char_length(file_name) between 1 and 255)
);

-- ----------------------------------------------------------- user_settings
create table public.user_settings (
  user_id             uuid primary key references public.profiles (id) on delete cascade,
  theme               text not null default 'dark' check (theme in ('dark', 'light')),
  sound_enabled       boolean not null default true,
  desktop_notifs      boolean not null default true,
  allow_message_from  text not null default 'everyone'
                        check (allow_message_from in ('everyone', 'contacts')),
  updated_at          timestamptz not null default now()
);
