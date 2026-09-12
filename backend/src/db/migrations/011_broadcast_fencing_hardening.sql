-- Applied to Supabase as 011_broadcast_fencing_hardening.
-- Keep this migration idempotent for local/bootstrap environments.
create or replace function public.heartbeat_now_playing(
  p_station_id uuid,
  p_elapsed_ms integer,
  p_state text default 'playing',
  p_control_revision bigint default null
)
returns public.now_playing
language plpgsql
security definer
set search_path = public
as $$
declare v_np public.now_playing;
begin
  if p_elapsed_ms < 0 then raise exception 'invalid_elapsed_ms'; end if;
  if p_state not in ('playing','paused','stopped') then raise exception 'invalid_now_playing_state'; end if;
  update public.now_playing
  set elapsed_ms=p_elapsed_ms,state=p_state,last_heartbeat_at=now(),updated_at=now(),revision=revision+1
  where station_id=p_station_id
    and (p_control_revision is null or control_revision=p_control_revision)
  returning * into v_np;
  if v_np.station_id is null then raise exception 'control_revision_conflict'; end if;
  return v_np;
end;
$$;

create or replace function public.claim_next_queue_item(p_station_id uuid)
returns public.broadcast_queue
language plpgsql
security definer
set search_path = public
as $$
declare v_item public.broadcast_queue;
begin
  select q.* into v_item
  from public.broadcast_queue q
  join public.media_assets m on m.id=q.media_asset_id
  where q.station_id=p_station_id
    and q.status='queued'
    and (q.scheduled_for is null or q.scheduled_for<=now())
    and m.status='ready'
  order by q.position asc,q.created_at asc
  for update of q skip locked
  limit 1;
  if v_item.id is null then return null; end if;
  update public.broadcast_queue
  set status='playing',claimed_at=coalesce(claimed_at,now()),started_at=coalesce(started_at,now()),failed_reason=null
  where id=v_item.id
  returning * into v_item;
  return v_item;
end;
$$;

revoke all on function public.heartbeat_now_playing(uuid,integer,text,bigint) from public,anon,authenticated;
revoke all on function public.claim_next_queue_item(uuid) from public,anon,authenticated;
