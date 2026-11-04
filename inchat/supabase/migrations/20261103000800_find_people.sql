-- Person search, for "start a chat".
--
-- It is a function rather than a client filter for two reasons: a PostgREST
-- filter string is built by concatenating what the keyboard typed, and the
-- tsquery this wants has operators of its own (& | ! ( ) : *) that a value
-- could otherwise be read as. Here the term is reduced to letters, digits and
-- underscores before it is ever handed to to_tsquery, and it is bound as a
-- parameter.
--
-- The expression matches the GIN index the profiles table already carries
-- (profiles_name_search_idx), so a prefix search costs an index probe instead
-- of a scan of every account.

create or replace function public.find_people(p_query text, p_limit integer default 20)
returns table (user_id uuid, name text, handle text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  needle text := btrim(regexp_replace(coalesce(p_query, ''), '[^[:alnum:]_]+', ' ', 'g'));
  bound integer := greatest(1, least(coalesce(p_limit, 20), 50));
begin
  -- An empty term is not "everybody": it is nobody. Without this the function
  -- would list the whole user base for a user who pressed search once.
  if needle = '' then
    return;
  end if;

  needle := left(needle, 64);

  return query
  select p.id, p.full_name, p.username
  from public.profiles p
  where p.is_profile_setup
    and p.id is distinct from (select auth.uid())
    and (
      -- Typed the whole username: that is the row they meant.
      p.username = needle::citext
      or to_tsvector('simple', p.username || ' ' || p.full_name)
         @@ to_tsquery('simple', replace(needle, ' ', ' & ') || ':*')
    )
  order by (p.username = needle::citext) desc, char_length(p.username), p.full_name
  limit bound;
end;
$$;

revoke all on function public.find_people(text,integer) from public, anon;
grant execute on function public.find_people(text,integer) to authenticated;
