-- 002_library_broadcast.sql
-- Media library, playlists, broadcast queue, and broadcast event timeline.
-- This is the schema that makes "now playing" and "the queue" backend-authoritative
-- instead of a frontend JS array.

CREATE TABLE IF NOT EXISTS artists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS albums (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id   UUID REFERENCES artists(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media_assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_provider TEXT NOT NULL,        -- 'local' | 's3' | ... (swappable)
  storage_key     TEXT NOT NULL,         -- path/key within that provider
  original_filename TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  uploaded_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE track_status AS ENUM ('pending','processing','ready','failed','inactive');
CREATE TYPE rights_status AS ENUM ('unknown','cleared','restricted','expired');

CREATE TABLE IF NOT EXISTS tracks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id  UUID NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  artist_id       UUID REFERENCES artists(id) ON DELETE SET NULL,
  album_id        UUID REFERENCES albums(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  genre           TEXT,
  duration_seconds NUMERIC(8,2),        -- extracted from real audio metadata, never guessed
  bitrate_kbps    INTEGER,
  sample_rate_hz  INTEGER,
  format          TEXT,
  bpm             NUMERIC(6,2),
  explicit        BOOLEAN NOT NULL DEFAULT false,
  rights_status   rights_status NOT NULL DEFAULT 'unknown',
  rights_notes    TEXT,
  status          track_status NOT NULL DEFAULT 'pending',
  processing_error TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tracks_status ON tracks(status);
CREATE INDEX IF NOT EXISTS idx_tracks_rights ON tracks(rights_status);

CREATE TABLE IF NOT EXISTS playlists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id  UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT false,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id),
  UNIQUE (playlist_id, position)
);

CREATE TYPE queue_status AS ENUM ('queued','playing','played','skipped','failed','cancelled');
CREATE TYPE queue_source AS ENUM ('playlist','ai','request','manual','emergency');

CREATE TABLE IF NOT EXISTS queue_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id      UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  track_id        UUID NOT NULL REFERENCES tracks(id) ON DELETE RESTRICT,
  source          queue_source NOT NULL DEFAULT 'playlist',
  status          queue_status NOT NULL DEFAULT 'queued',
  position        INTEGER NOT NULL,       -- ordering among 'queued' items
  scheduled_start TIMESTAMPTZ,            -- computed authoritative start time
  actual_start    TIMESTAMPTZ,
  actual_end      TIMESTAMPTZ,
  requested_by    UUID REFERENCES users(id),
  inserted_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_queue_station_status ON queue_items(station_id, status);
-- Only one item may be 'playing' per station at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_playing_per_station
  ON queue_items(station_id) WHERE status = 'playing';

CREATE TYPE broadcast_state AS ENUM ('offline','starting','live','degraded','failover','stopping');

CREATE TABLE IF NOT EXISTS broadcast_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id  UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  state       broadcast_state NOT NULL DEFAULT 'offline',
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  started_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Only one non-ended session per station.
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_session_per_station
  ON broadcast_sessions(station_id) WHERE ended_at IS NULL;

-- Append-only operational timeline: "why did this track play?" / "why did AI say this?"
CREATE TABLE IF NOT EXISTS broadcast_events (
  id              BIGSERIAL PRIMARY KEY,
  station_id      UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  session_id      UUID REFERENCES broadcast_sessions(id),
  event_type      TEXT NOT NULL,   -- TRACK_STARTED, TRACK_COMPLETED, QUEUE_ADVANCED, AI_INSERT, etc.
  queue_item_id   UUID REFERENCES queue_items(id),
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id  UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_broadcast_events_station_time ON broadcast_events(station_id, created_at);

-- Seed a default station so the queue/broadcast API has something to operate on.
INSERT INTO stations (slug, name, timezone)
VALUES ('nycefm', 'NYCE FM 36.9', 'America/New_York')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO station_settings (station_id, settings)
SELECT id, '{}'::jsonb FROM stations WHERE slug = 'nycefm'
ON CONFLICT (station_id) DO NOTHING;
