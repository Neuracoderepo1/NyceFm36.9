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
