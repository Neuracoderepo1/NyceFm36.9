-- 014_authoritative_queue_write_path.sql
-- Was entirely missing from the repo, even though 014_finalize_queue_item_fix.sql
-- (a patch on top of this migration's finalize_queue_item()) already existed
-- in source control. Replaying migrations from a clean database would have
-- failed: enqueue_queue_item() wouldn't exist, and the fix file's
-- CREATE OR REPLACE would have nothing prior to replace.
--
-- Reconstructed verbatim from the live migration on project
-- qmrqkmddkveoinvspqvn (supabase_migrations.schema_migrations,
-- version 20260913064206, name "014_authoritative_queue_write_path").
--
-- Establishes the single transactional write path for the broadcast queue:
-- enqueue_queue_item() to add items, finalize_queue_item() to close them out.
-- The version of finalize_queue_item() defined here was superseded later the
-- same day by 014_finalize_queue_item_fix.sql -- kept here unmodified for an
-- accurate history.

create or replace function public.enqueue_queue_item(
  p_station_id uuid,
  p_media_asset_id uuid,
  p_source text,
  p_requested_by uuid default null,
  p_scheduled_for timestamptz default null
)
returns public.broadcast_queue
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_item public.broadcast_queue;
begin
  if p_source not in ('playlist','dj','producer','ai','system') then
    raise exception 'invalid_queue_source';
  end if;

  if not exists (
    select 1 from public.media_assets
    where id = p_media_asset_id
      and station_id = p_station_id
      and status = 'ready'
  ) then
    raise exception 'media_asset_not_ready';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_station_id::text));

  insert into public.broadcast_queue (
    station_id, media_asset_id, source, requested_by, position, scheduled_for
  )
  select
    p_station_id,
    p_media_asset_id,
    p_source,
    p_requested_by,
    coalesce(max(position) + 1, 0),
    p_scheduled_for
  from public.broadcast_queue
  where station_id = p_station_id
    and status = 'queued'
  returning * into v_item;

  return v_item;
end;
$function$;

create or replace function public.finalize_queue_item(
  p_station_id uuid,
  p_queue_item_id uuid,
  p_status text,
  p_failed_reason text default null,
  p_event_type text default 'track_finished',
  p_event_payload jsonb default '{}'::jsonb,
  p_incident_code text default null,
  p_incident_message text default null,
  p_incident_metadata jsonb default '{}'::jsonb
)
returns public.now_playing
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_np public.now_playing;
begin
  if p_status not in ('played','skipped','failed') then
    raise exception 'invalid_queue_final_status';
  end if;

  update public.broadcast_queue
  set status = p_status,
      ended_at = now(),
      failed_reason = p_failed_reason
  where id = p_queue_item_id
    and station_id = p_station_id
  returning * into strict v_np;

  update public.now_playing
  set state = 'idle',
      queue_item_id = null,
      media_asset_id = null,
      started_at = null,
      elapsed_ms = 0,
      last_heartbeat_at = null,
      revision = revision + 1,
      control_revision = control_revision + 1,
      updated_at = now()
  where station_id = p_station_id
    and queue_item_id = p_queue_item_id
  returning * into v_np;

  if v_np.station_id is null then
    select * into v_np from public.now_playing where station_id = p_station_id;
  end if;

  insert into public.stream_events(station_id,event_type,queue_item_id,payload)
  values (p_station_id,p_event_type,p_queue_item_id,coalesce(p_event_payload,'{}'::jsonb));

  if p_incident_code is not null then
    insert into public.broadcast_incidents(station_id,severity,code,message,metadata)
    values (p_station_id,'critical',p_incident_code,coalesce(p_incident_message,p_incident_code),coalesce(p_incident_metadata,'{}'::jsonb));
  end if;

  return v_np;
exception
  when no_data_found then
    raise exception 'queue_item_not_found';
end;
$function$;

revoke all on function public.enqueue_queue_item(uuid,uuid,text,uuid,timestamptz) from public, anon, authenticated;
revoke all on function public.finalize_queue_item(uuid,uuid,text,text,text,jsonb,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_queue_item(uuid,uuid,text,uuid,timestamptz) to service_role;
grant execute on function public.finalize_queue_item(uuid,uuid,text,text,text,jsonb,text,text,jsonb) to service_role;
