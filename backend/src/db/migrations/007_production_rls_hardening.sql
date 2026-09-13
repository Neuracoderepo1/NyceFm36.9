-- 007_production_rls_hardening.sql
-- Replaces the placeholder 007_production_security.sql, which described a
-- dynamic RLS-enable loop that is NOT what actually ran against production.
--
-- Reconstructed verbatim from the live migration on project
-- qmrqkmddkveoinvspqvn (supabase_migrations.schema_migrations,
-- version 20260912063400, name "007_production_rls_hardening").
--
-- Explicitly enables RLS per table (rather than looping over pg_tables),
-- revokes broad grants schema-wide, and documents the access model: the
-- application's own server-side session/RBAC layer is the authority;
-- browser clients must use the application API, not direct table access.

CREATE SCHEMA IF NOT EXISTS extensions;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='citext' AND extnamespace=(SELECT oid FROM pg_namespace WHERE nspname='public')) THEN
    ALTER EXTENSION citext SET SCHEMA extensions;
  END IF;
END $$;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.station_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.now_playing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stream_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listener_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listener_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listener_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dedications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listener_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audience_polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audience_poll_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audience_poll_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audience_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audience_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_station_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_voice_segments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

COMMENT ON SCHEMA public IS 'NYCE FM application schema. RLS is enabled on application tables; browser clients must use the application API rather than direct table access.';
COMMENT ON SCHEMA extensions IS 'Non-public PostgreSQL extensions for NYCE FM.';
