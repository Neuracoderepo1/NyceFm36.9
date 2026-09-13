-- 014_finalize_queue_item_fix.sql
-- Fix to public.finalize_queue_item() applied directly to production
-- after the initial 014_authoritative_queue_write_path migration.
--
-- Reconstructed verbatim from the live function definition on project
-- qmrqkmddkveoinvspqvn (CREATE OR REPLACE is idempotent, so this
-- safely reproduces the current production behavior regardless of
-- what the pre-fix version looked like).

CREATE OR REPLACE FUNCTION public.finalize_queue_item(
  p_station_id uuid,
  p_queue_item_id uuid,
  p_status text,
  p_failed_reason text DEFAULT NULL::text,
  p_event_type text DEFAULT 'track_finished'::text,
  p_event_payload jsonb DEFAULT '{}'::jsonb,
  p_incident_code text DEFAULT NULL::text,
  p_incident_message text DEFAULT NULL::text,
  p_incident_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS now_playing
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_queue public.broadcast_queue;
  v_np public.now_playing;
begin
  if p_status not in ('played','skipped','failed') then
    raise exception 'invalid_queue_final_status';
  end if;
  update public.broadcast_queue set status=p_status, ended_at=now(), failed_reason=p_failed_reason where id=p_queue_item_id and station_id=p_station_id returning * into v_queue;
  if v_queue.id is null then raise exception 'queue_item_not_found'; end if;
  update public.now_playing set state='idle', queue_item_id=null, media_asset_id=null, started_at=null, elapsed_ms=0, last_heartbeat_at=null, revision=revision+1, control_revision=control_revision+1, updated_at=now() where station_id=p_station_id and queue_item_id=p_queue_item_id returning * into v_np;
  if v_np.station_id is null then select * into v_np from public.now_playing where station_id=p_station_id; end if;
  insert into public.stream_events(station_id,event_type,queue_item_id,payload) values(p_station_id,p_event_type,p_queue_item_id,coalesce(p_event_payload,'{}'::jsonb));
  if p_incident_code is not null then insert into public.broadcast_incidents(station_id,severity,code,message,metadata) values(p_station_id,'critical',p_incident_code,coalesce(p_incident_message,p_incident_code),coalesce(p_incident_metadata,'{}'::jsonb)); end if;
  return v_np;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.finalize_queue_item(uuid,uuid,text,text,text,jsonb,text,text,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_queue_item(uuid,uuid,text,text,text,jsonb,text,text,jsonb) TO service_role;
