-- Phase 2B: streaming/ingestion state.
CREATE TABLE IF NOT EXISTS stream_events (
  id BIGSERIAL PRIMARY KEY,
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('started','stopped','track_started','track_finished','track_failed','health_degraded')),
  queue_item_id UUID REFERENCES broadcast_queue(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stream_events_station_created ON stream_events(station_id, created_at DESC);

ALTER TABLE station_settings
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
