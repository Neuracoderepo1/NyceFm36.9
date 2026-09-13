-- 013_media_asset_pipeline_metadata.sql
-- Adds audio-pipeline and rights metadata to media_assets.
--
-- Reconstructed from the live production schema on project
-- qmrqkmddkveoinvspqvn: this migration was applied directly to
-- production before ever being committed to source control.

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS bitrate_kbps INTEGER,
  ADD COLUMN IF NOT EXISTS sample_rate_hz INTEGER,
  ADD COLUMN IF NOT EXISTS bpm NUMERIC,
  ADD COLUMN IF NOT EXISTS explicit BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rights_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS rights_notes TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_assets_rights_status_check'
  ) THEN
    ALTER TABLE media_assets
      ADD CONSTRAINT media_assets_rights_status_check
      CHECK (rights_status = ANY (ARRAY['unknown','cleared','restricted','expired']));
  END IF;
END $$;
