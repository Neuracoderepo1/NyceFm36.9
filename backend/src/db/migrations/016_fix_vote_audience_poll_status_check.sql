-- 016_fix_vote_audience_poll_status_check.sql
-- Fixes public.vote_audience_poll(), which was checking
-- audience_polls.status = 'published' -- a value the column's CHECK
-- constraint (005_audience_platform.sql: 'draft','active','closed')
-- never allows. As originally written the RPC could never succeed;
-- every call hit poll_not_open.
--
-- 'active' is the status value that means "open for voting", so that's
-- the correct check. Applied directly to production
-- (qmrqkmddkveoinvspqvn, version 20260913081428) and reproduced here.

create or replace function public.vote_audience_poll(
  p_poll_id uuid,
  p_option_id uuid,
  p_user_id uuid default null,
  p_anonymous_id text default null
)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  if p_user_id is null and (p_anonymous_id is null or length(trim(p_anonymous_id)) < 8) then
    raise exception 'missing_voter_identity' using errcode = '22023';
  end if;

  if not exists (select 1 from public.audience_polls where id = p_poll_id and status = 'active') then
    raise exception 'poll_not_open' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.audience_poll_options where id = p_option_id and poll_id = p_poll_id) then
    raise exception 'invalid_poll_option' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_poll_id::text || ':' || coalesce(p_user_id::text, p_anonymous_id), 0));

  if exists (
    select 1 from public.audience_poll_votes
    where poll_id = p_poll_id
      and ((p_user_id is not null and user_id = p_user_id) or (p_user_id is null and anonymous_id = p_anonymous_id))
  ) then
    return false;
  end if;

  insert into public.audience_poll_votes (poll_id, option_id, user_id, anonymous_id, created_at)
  values (p_poll_id, p_option_id, p_user_id, case when p_user_id is null then p_anonymous_id else null end, now());

  return true;
end;
$$;

revoke all on function public.vote_audience_poll(uuid,uuid,uuid,text) from public, anon, authenticated;
