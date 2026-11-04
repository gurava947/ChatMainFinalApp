-- Supabase Storage: one private bucket for chat media, addressed by the
-- conversation the file belongs to.
--
-- Object path convention (the client builds it, the policy reads it):
--   {conversation_id}/{uploaded_by_user_id}/{random_uuid}.{ext}
--
-- Because the conversation id is the first path segment, membership is the only
-- thing that has to be proven to allow a download - no per-message lookup.

create or replace function public.private_path_conversation(object_name text)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  -- A malformed name must not abort the whole statement for an unrelated row,
  -- so a non-uuid first segment resolves to null and fails the membership test.
  select case
    when split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(object_name, '/', 1)::uuid
  end;
$$;

create or replace function public.private_path_uploader(object_name text)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when split_part(object_name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(object_name, '/', 2)::uuid
  end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-media',
  'chat-media',
  false,
  -- 50 MB: covers the HD photo and short-voice paths the composer offers.
  52428800,
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm', 'video/quicktime',
    'audio/webm', 'audio/mpeg', 'audio/ogg', 'audio/mp4',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'application/zip'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "chat_media_select_member" on storage.objects;
create policy "chat_media_select_member"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'chat-media'
    and public.is_conversation_member(
          public.private_path_conversation(name), (select auth.uid())
        )
  );

drop policy if exists "chat_media_insert_member" on storage.objects;
create policy "chat_media_insert_member"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'chat-media'
    -- The uploader slot in the path has to be the caller, or someone could
    -- upload into a conversation while pretending to be another member.
    and public.private_path_uploader(name) = (select auth.uid())
    and public.is_conversation_member(
          public.private_path_conversation(name), (select auth.uid())
        )
  );

drop policy if exists "chat_media_delete_owner_or_admin" on storage.objects;
create policy "chat_media_delete_owner_or_admin"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'chat-media'
    and (
      public.private_path_uploader(name) = (select auth.uid())
      or public.is_conversation_admin(
           public.private_path_conversation(name), (select auth.uid())
         )
    )
  );
