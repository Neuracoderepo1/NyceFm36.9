-- 008_production_data_plane.sql
-- Replaces the previous 008_production_data_plane.sql, which was missing
-- several objects that are live on production and undocumented anywhere
-- else in source control.
--
-- Reconstructed verbatim from the live migration on project
-- qmrqkmddkveoinvspqvn (supabase_migrations.schema_migrations,
-- version 20260912064345, name "008_production_data_plane").
--
-- Notably restores:
--   * the `private` schema + private.set_updated_at() trigger function
--     (the old file wrongly created an equivalent function in `public`)
--   * public.vote_audience_poll(), a live RPC with no prior source record
--   * the real storage bucket config (500MB limit, MIME allowlist)
--   * ~25 FK/hot-path indexes that exist on production

create index if not exists idx_media_assets_station_id on public.media_assets(station_id);
create index if not exists idx_playlists_station_id on public.playlists(station_id);
create index if not exists idx_playlist_items_playlist_id on public.playlist_items(playlist_id);
create index if not exists idx_playlist_items_media_asset_id on public.playlist_items(media_asset_id);
create index if not exists idx_broadcast_queue_station_status_position on public.broadcast_queue(station_id,status,position);
create index if not exists idx_broadcast_queue_media_asset_id on public.broadcast_queue(media_asset_id);
create index if not exists idx_broadcast_sessions_station_started_at on public.broadcast_sessions(station_id,started_at desc);
create index if not exists idx_now_playing_station_id on public.now_playing(station_id);
create index if not exists idx_stream_events_station_created_at on public.stream_events(station_id,created_at desc);
create index if not exists idx_broadcast_schedules_station_id on public.broadcast_schedules(station_id);
create index if not exists idx_broadcast_overrides_station_id on public.broadcast_overrides(station_id);
create index if not exists idx_broadcast_incidents_station_id_created_at on public.broadcast_incidents(station_id,created_at desc);
create index if not exists idx_listener_presence_station_last_seen on public.listener_presence(station_id,last_seen_at desc);
create index if not exists idx_listener_requests_station_status_created_at on public.listener_requests(station_id,status,created_at desc);
create index if not exists idx_dedications_station_created_at on public.dedications(station_id,created_at desc);
create index if not exists idx_listener_reactions_station_created_at on public.listener_reactions(station_id,created_at desc);
create index if not exists idx_audience_polls_station_status on public.audience_polls(station_id,status);
create index if not exists idx_audience_messages_station_created_at on public.audience_messages(station_id,created_at desc);
create index if not exists idx_audience_events_station_occurred_at on public.audience_events(station_id,occurred_at desc);
create index if not exists idx_ai_runs_station_started_at on public.ai_runs(station_id,started_at desc);
create index if not exists idx_ai_actions_station_status_created_at on public.ai_actions(station_id,status,created_at desc);
create index if not exists idx_ai_voice_segments_station_created_at on public.ai_voice_segments(station_id,created_at desc);
create unique index if not exists uq_now_playing_station on public.now_playing(station_id);
create unique index if not exists uq_ai_station_config_station on public.ai_station_config(station_id);
create index if not exists idx_audience_poll_votes_poll_id on public.audience_poll_votes(poll_id);
create index if not exists idx_audience_poll_votes_option_id on public.audience_poll_votes(option_id);

create schema if not exists private;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public;

drop trigger if exists trg_station_settings_updated_at on public.station_settings;
create trigger trg_station_settings_updated_at before update on public.station_settings for each row execute function private.set_updated_at();

drop trigger if exists trg_media_assets_updated_at on public.media_assets;
create trigger trg_media_assets_updated_at before update on public.media_assets for each row execute function private.set_updated_at();

drop trigger if exists trg_playlists_updated_at on public.playlists;
create trigger trg_playlists_updated_at before update on public.playlists for each row execute function private.set_updated_at();

drop trigger if exists trg_now_playing_updated_at on public.now_playing;
create trigger trg_now_playing_updated_at before update on public.now_playing for each row execute function private.set_updated_at();

drop trigger if exists trg_broadcast_programs_updated_at on public.broadcast_programs;
create trigger trg_broadcast_programs_updated_at before update on public.broadcast_programs for each row execute function private.set_updated_at();

drop trigger if exists trg_broadcast_schedules_updated_at on public.broadcast_schedules;
create trigger trg_broadcast_schedules_updated_at before update on public.broadcast_schedules for each row execute function private.set_updated_at();

drop trigger if exists trg_listener_profiles_updated_at on public.listener_profiles;
create trigger trg_listener_profiles_updated_at before update on public.listener_profiles for each row execute function private.set_updated_at();

drop trigger if exists trg_audience_polls_updated_at on public.audience_polls;
create trigger trg_audience_polls_updated_at before update on public.audience_polls for each row execute function private.set_updated_at();

drop trigger if exists trg_ai_station_config_updated_at on public.ai_station_config;
create trigger trg_ai_station_config_updated_at before update on public.ai_station_config for each row execute function private.set_updated_at();

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

  if not exists (select 1 from public.audience_polls where id = p_poll_id and status = 'published') then
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

-- Note: the poll status check above uses 'published', which
-- audience_polls.status (constrained to 'draft'/'active'/'closed' as of
-- 005_audience_platform.sql) never allows -- meaning this RPC could never
-- succeed as originally deployed. Reproduced as-is here since this
-- migration documents exactly what was live at the time; corrected by
-- 016_fix_vote_audience_poll_status_check.sql.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'nycefm-media', 'nycefm-media', false, 524288000,
  array['audio/mpeg','audio/mp4','audio/wav','audio/x-wav','audio/ogg','audio/aac','image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

revoke all on storage.objects from anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='now_playing') then
    alter publication supabase_realtime add table public.now_playing;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='broadcast_queue') then
    alter publication supabase_realtime add table public.broadcast_queue;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='listener_presence') then
    alter publication supabase_realtime add table public.listener_presence;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='audience_events') then
    alter publication supabase_realtime add table public.audience_events;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='ai_actions') then
    alter publication supabase_realtime add table public.ai_actions;
  end if;
end $$;
