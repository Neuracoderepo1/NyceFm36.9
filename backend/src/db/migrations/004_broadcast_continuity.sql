-- Phase 2C: continuous broadcast control plane, scheduling and watchdog state.
CREATE TABLE IF NOT EXISTS broadcast_programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  playlist_id UUID REFERENCES playlists(id) ON DELETE SET NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(station_id, name)
);
CREATE TABLE IF NOT EXISTS broadcast_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  program_id UUID REFERENCES broadcast_programs(id) ON DELETE SET NULL,
  playlist_id UUID REFERENCES playlists(id) ON DELETE SET NULL,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_local TIME NOT NULL,
  end_local TIME NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (start_local <> end_local)
);
CREATE INDEX IF NOT EXISTS idx_broadcast_schedules_station_day ON broadcast_schedules(station_id, day_of_week, enabled, priority);

CREATE TABLE IF NOT EXISTS broadcast_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('automation','dj','emergency')),
  reason TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  activated_by UUID REFERENCES users(id),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_broadcast_active_override ON broadcast_overrides(station_id) WHERE active = true;

CREATE TABLE IF NOT EXISTS broadcast_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  resolved_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_broadcast_incidents_station_open ON broadcast_incidents(station_id, resolved_at) WHERE resolved_at IS NULL;

ALTER TABLE now_playing ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
ALTER TABLE now_playing ADD COLUMN IF NOT EXISTS control_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE now_playing ADD COLUMN IF NOT EXISTS transition_mode TEXT NOT NULL DEFAULT 'hard' CHECK (transition_mode IN ('hard','crossfade'));

ALTER TABLE broadcast_queue ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE broadcast_queue ADD COLUMN IF NOT EXISTS failed_reason TEXT;

INSERT INTO station_settings (station_id, settings)
SELECT id, '{"stream":{"provider":"hls","status":"not_configured"},"broadcast":{"mode":"automation","transition":"hard","watchdog":{"enabled":true}}}'::jsonb
FROM stations WHERE slug='nyce-fm'
ON CONFLICT (station_id) DO UPDATE SET settings = station_settings.settings || EXCLUDED.settings;
