-- 013_media_asset_pipeline_metadata.sql
-- Adds audio-pipeline and rights metadata to media_assets.
--
-- Reconstructed from the live production schema on project
-- qmrqkmddkveoinvspqvn: this migration was applied directly to
-- production before ever being committed to source control.
--
-- Corrected against the live migration text (version 20260913062305):
-- bpm is NUMERIC(6,2) on production, not untyped NUMERIC, and production
-- also created idx_media_assets_rights_status, which this file was
-- previously missing.

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS bitrate_kbps INTEGER,
  ADD COLUMN IF NOT EXISTS sample_rate_hz INTEGER,
  ADD COLUMN IF NOT EXISTS bpm NUMERIC(6,2),
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

CREATE INDEX IF NOT EXISTS idx_media_assets_rights_status ON media_assets(rights_status);
