-- 015_authoritative_broadcast_session_lifecycle.sql
-- Was entirely missing from the repo. Live and in use on production with
-- no prior source-control record.
--
-- Reconstructed verbatim from the live migration on project
-- qmrqkmddkveoinvspqvn (supabase_migrations.schema_migrations,
-- version 20260913064512, name "015_authoritative_broadcast_session_lifecycle").
--
-- NYCE FM authoritative broadcast session lifecycle.
-- Node remains the actor/RBAC boundary; these SECURITY DEFINER RPCs are the
-- single transactional write path for session + now_playing state.

create or replace function public.start_broadcast_session(
  p_station_id uuid,
  p_started_by uuid,
  p_mode text default 'operator'
)
returns public.broadcast_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.broadcast_sessions;
begin
  if p_mode not in ('operator','scheduled','ai','automation') then
    raise exception 'invalid_broadcast_mode';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_station_id::text));

  select * into v_session
  from public.broadcast_sessions
  where station_id = p_station_id and status = 'active'
  order by started_at desc
  limit 1
  for update;

  if v_session.id is not null then
    return v_session;
  end if;

  insert into public.broadcast_sessions (station_id, started_by, mode, status)
  values (p_station_id, p_started_by, p_mode, 'active')
  returning * into v_session;

  insert into public.now_playing (
    station_id, broadcast_session_id, state, elapsed_ms,
    revision, control_revision, transition_mode, updated_at
  )
  values (
    p_station_id, v_session.id, 'idle', 0,
    1, 0, 'hard', now()
  )
  on conflict (station_id) do update set
    broadcast_session_id = excluded.broadcast_session_id,
    queue_item_id = null,
    media_asset_id = null,
    started_at = null,
    elapsed_ms = 0,
    state = 'idle',
    revision = public.now_playing.revision + 1,
    updated_at = now(),
    last_heartbeat_at = null;

  return v_session;
end;
$$;

create or replace function public.stop_broadcast_session(
  p_station_id uuid
)
returns public.broadcast_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.broadcast_sessions;
begin
  perform pg_advisory_xact_lock(hashtext(p_station_id::text));

  update public.broadcast_sessions
  set status = 'stopped', ended_at = now()
  where station_id = p_station_id and status = 'active'
  returning * into v_session;

  insert into public.now_playing (
    station_id, state, elapsed_ms, revision,
    control_revision, transition_mode, updated_at
  )
  values (
    p_station_id, 'stopped', 0, 1,
    0, 'hard', now()
  )
  on conflict (station_id) do update set
    state = 'stopped',
    queue_item_id = null,
    media_asset_id = null,
    broadcast_session_id = null,
    started_at = null,
    elapsed_ms = 0,
    revision = public.now_playing.revision + 1,
    control_revision = public.now_playing.control_revision + 1,
    updated_at = now(),
    last_heartbeat_at = null;

  return v_session;
end;
$$;

revoke execute on function public.start_broadcast_session(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.stop_broadcast_session(uuid) from public, anon, authenticated;
grant execute on function public.start_broadcast_session(uuid, uuid, text) to service_role;
grant execute on function public.stop_broadcast_session(uuid) to service_role;
