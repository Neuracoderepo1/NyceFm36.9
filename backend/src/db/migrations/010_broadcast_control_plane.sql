-- Authoritative broadcast control plane. All mutations are fenced and audited by the API layer.
CREATE OR REPLACE FUNCTION public.claim_next_queue_item(p_station_id uuid)
RETURNS public.broadcast_queue LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_item public.broadcast_queue;
BEGIN
  SELECT q.* INTO v_item FROM public.broadcast_queue q JOIN public.media_assets m ON m.id=q.media_asset_id
  WHERE q.station_id=p_station_id AND q.status='queued' AND (q.scheduled_for IS NULL OR q.scheduled_for<=now()) AND m.status='ready'
  ORDER BY q.position ASC,q.created_at ASC FOR UPDATE OF q SKIP LOCKED LIMIT 1;
  IF v_item.id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.broadcast_queue SET status='playing',claimed_at=coalesce(claimed_at,now()),started_at=coalesce(started_at,now()),failed_reason=NULL WHERE id=v_item.id RETURNING * INTO v_item;
  RETURN v_item;
END $$;

CREATE OR REPLACE FUNCTION public.advance_now_playing(p_station_id uuid,p_queue_item_id uuid,p_media_asset_id uuid,p_broadcast_session_id uuid,p_transition_mode text DEFAULT 'auto')
RETURNS public.now_playing LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_np public.now_playing;
BEGIN
  IF p_transition_mode NOT IN ('auto','manual','ai','emergency') THEN RAISE EXCEPTION 'invalid_transition_mode'; END IF;
  INSERT INTO public.now_playing(station_id,queue_item_id,media_asset_id,broadcast_session_id,started_at,elapsed_ms,state,revision,updated_at,last_heartbeat_at,control_revision,transition_mode)
  VALUES(p_station_id,p_queue_item_id,p_media_asset_id,p_broadcast_session_id,now(),0,'playing',1,now(),now(),1,p_transition_mode)
  ON CONFLICT(station_id) DO UPDATE SET queue_item_id=excluded.queue_item_id,media_asset_id=excluded.media_asset_id,broadcast_session_id=excluded.broadcast_session_id,started_at=excluded.started_at,elapsed_ms=0,state='playing',revision=public.now_playing.revision+1,updated_at=now(),last_heartbeat_at=now(),control_revision=public.now_playing.control_revision+1,transition_mode=excluded.transition_mode
  RETURNING * INTO v_np; RETURN v_np;
END $$;

CREATE OR REPLACE FUNCTION public.heartbeat_now_playing(p_station_id uuid,p_elapsed_ms integer,p_state text DEFAULT 'playing',p_control_revision bigint DEFAULT NULL)
RETURNS public.now_playing LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_np public.now_playing;
BEGIN
  IF p_elapsed_ms<0 THEN RAISE EXCEPTION 'invalid_elapsed_ms'; END IF;
  IF p_state NOT IN ('playing','paused','stopped') THEN RAISE EXCEPTION 'invalid_now_playing_state'; END IF;
  UPDATE public.now_playing SET elapsed_ms=p_elapsed_ms,state=p_state,last_heartbeat_at=now(),updated_at=now(),revision=revision+1 WHERE station_id=p_station_id AND (p_control_revision IS NULL OR control_revision=p_control_revision) RETURNING * INTO v_np;
  IF v_np.station_id IS NULL THEN RAISE EXCEPTION 'control_revision_conflict'; END IF; RETURN v_np;
END $$;

CREATE OR REPLACE FUNCTION public.control_now_playing(p_station_id uuid,p_action text,p_expected_control_revision bigint DEFAULT NULL)
RETURNS public.now_playing LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_np public.now_playing;
BEGIN
  IF p_action NOT IN ('pause','resume','stop','skip','emergency_stop') THEN RAISE EXCEPTION 'invalid_control_action'; END IF;
  UPDATE public.now_playing SET state=CASE WHEN p_action='pause' THEN 'paused' WHEN p_action='resume' THEN 'playing' WHEN p_action IN ('stop','skip','emergency_stop') THEN 'stopped' ELSE state END,control_revision=control_revision+1,revision=revision+1,updated_at=now(),last_heartbeat_at=now() WHERE station_id=p_station_id AND (p_expected_control_revision IS NULL OR control_revision=p_expected_control_revision) RETURNING * INTO v_np;
  IF v_np.station_id IS NULL THEN RAISE EXCEPTION 'control_revision_conflict'; END IF; RETURN v_np;
END $$;

CREATE OR REPLACE FUNCTION public.upsert_listener_presence(p_station_id uuid,p_user_id uuid,p_anonymous_id text)
RETURNS public.listener_presence LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_presence public.listener_presence;
BEGIN
  IF p_user_id IS NULL AND nullif(trim(p_anonymous_id),'') IS NULL THEN RAISE EXCEPTION 'listener_identity_required'; END IF;
  SELECT * INTO v_presence FROM public.listener_presence WHERE station_id=p_station_id AND ((p_user_id IS NOT NULL AND user_id=p_user_id) OR (p_user_id IS NULL AND anonymous_id=p_anonymous_id)) AND disconnected_at IS NULL ORDER BY last_seen_at DESC LIMIT 1 FOR UPDATE;
  IF v_presence.id IS NULL THEN INSERT INTO public.listener_presence(station_id,user_id,anonymous_id,connected_at,last_seen_at) VALUES(p_station_id,p_user_id,nullif(trim(p_anonymous_id),''),now(),now()) RETURNING * INTO v_presence; ELSE UPDATE public.listener_presence SET last_seen_at=now() WHERE id=v_presence.id RETURNING * INTO v_presence; END IF;
  RETURN v_presence;
END $$;

REVOKE ALL ON FUNCTION public.claim_next_queue_item(uuid) FROM public,anon,authenticated;
REVOKE ALL ON FUNCTION public.advance_now_playing(uuid,uuid,uuid,uuid,text) FROM public,anon,authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_now_playing(uuid,integer,text,bigint) FROM public,anon,authenticated;
REVOKE ALL ON FUNCTION public.control_now_playing(uuid,text,bigint) FROM public,anon,authenticated;
REVOKE ALL ON FUNCTION public.upsert_listener_presence(uuid,uuid,text) FROM public,anon,authenticated;
