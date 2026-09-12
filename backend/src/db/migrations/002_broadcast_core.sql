-- 002_broadcast_core.sql
-- Phase 2: media catalog, playlists, broadcast queue/state.
-- Forward-only migration.

CREATE TABLE IF NOT EXISTS media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  genre TEXT,
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  mime_type TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  file_size_bytes BIGINT CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  sha256 TEXT,
  cover_art_key TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing','ready','failed','archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_assets_station_status ON media_assets(station_id, status);
CREATE INDEX IF NOT EXISTS idx_media_assets_artist_title ON media_assets(artist, title);

CREATE TABLE IF NOT EXISTS playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','smart','system')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(station_id, name)
);

CREATE TABLE IF NOT EXISTS playlist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(playlist_id, position)
);
CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist_position ON playlist_items(playlist_id, position);

CREATE TABLE IF NOT EXISTS broadcast_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  media_asset_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('playlist','dj','producer','ai','system')),
  requested_by UUID REFERENCES users(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','playing','played','skipped','failed')),
  scheduled_for TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_broadcast_queue_station_status_position ON broadcast_queue(station_id, status, position);

CREATE TABLE IF NOT EXISTS broadcast_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  started_by UUID REFERENCES users(id),
  mode TEXT NOT NULL DEFAULT 'operator' CHECK (mode IN ('operator','scheduled','ai','automation')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_broadcast_sessions_station_status ON broadcast_sessions(station_id, status);

CREATE TABLE IF NOT EXISTS now_playing (
  station_id UUID PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  queue_item_id UUID REFERENCES broadcast_queue(id) ON DELETE SET NULL,
  media_asset_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  broadcast_session_id UUID REFERENCES broadcast_sessions(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_ms >= 0),
  state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','playing','paused','stopped')),
  revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO stations (slug, name, timezone)
VALUES ('nyce-fm', 'NYCE FM', COALESCE(current_setting('TIMEZONE', true), 'UTC'))
ON CONFLICT (slug) DO NOTHING;

INSERT INTO station_settings (station_id, settings)
SELECT id, '{"stream":{"provider":"icecast","status":"not_configured"},"broadcast":{"mode":"offline"}}'::jsonb
FROM stations WHERE slug = 'nyce-fm'
ON CONFLICT (station_id) DO NOTHING;
