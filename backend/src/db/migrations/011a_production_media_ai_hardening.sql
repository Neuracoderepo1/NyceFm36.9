-- 011a_production_media_ai_hardening.sql
-- Renamed from 012_production_media_ai_hardening.sql, which collided with
-- 012_dj_producer_permission_matrix.sql (two files both prefixed "012").
--
-- On production this ran as an unprefixed migration named
-- "production_media_ai_hardening" (version 20260912071642), chronologically
-- BEFORE 012_dj_producer_permission_matrix (version 20260912194948). The
-- 011a prefix reflects that true order and resolves the collision so
-- filename-sorted migration runners apply things in the right sequence.
--
-- Final application-level invariants for the production media/AI plane.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='media_assets_storage_provider_check') THEN
    ALTER TABLE public.media_assets ADD CONSTRAINT media_assets_storage_provider_check CHECK (storage_provider IN ('local','supabase'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_media_assets_storage_provider_status ON public.media_assets(storage_provider,status);
CREATE INDEX IF NOT EXISTS idx_ai_actions_station_created_at ON public.ai_actions(station_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_resource ON public.audit_events(resource_type,resource_id,created_at DESC);
