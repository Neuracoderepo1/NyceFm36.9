-- Phase 4: AI DJ & Station Intelligence
CREATE TABLE IF NOT EXISTS ai_station_config (
  station_id UUID PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  autonomous_mode BOOLEAN NOT NULL DEFAULT false,
  max_actions_per_hour INTEGER NOT NULL DEFAULT 30 CHECK (max_actions_per_hour BETWEEN 1 AND 500),
  max_consecutive_ai_tracks INTEGER NOT NULL DEFAULT 3 CHECK (max_consecutive_ai_tracks BETWEEN 1 AND 20),
  min_request_confidence NUMERIC(5,4) NOT NULL DEFAULT 0.7500 CHECK (min_request_confidence BETWEEN 0 AND 1),
  require_human_approval BOOLEAN NOT NULL DEFAULT true,
  system_prompt TEXT,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('recommendation','autonomous')),
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','rejected','failed')),
  input_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_station_time ON ai_runs(station_id,started_at DESC);

CREATE TABLE IF NOT EXISTS ai_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES ai_runs(id) ON DELETE SET NULL,
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('queue_track','skip_track','speak','hold','no_action')),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','executed','rejected','failed')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale TEXT,
  confidence NUMERIC(5,4) CHECK (confidence BETWEEN 0 AND 1),
  approved_by UUID REFERENCES users(id),
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_actions_station_status ON ai_actions(station_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS ai_voice_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('intro','link','outro','request','dedication','emergency')),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  audio_key TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','queued','played','rejected')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_voice_segments_station_status ON ai_voice_segments(station_id,status,created_at DESC);

INSERT INTO permissions(code) VALUES ('ai.read'),('ai.control'),('ai.configure') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name='ADMIN' AND p.code IN ('ai.read','ai.control','ai.configure') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name='SUPER_ADMIN' AND p.code IN ('ai.read','ai.control','ai.configure') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name='MODERATOR' AND p.code='ai.read' ON CONFLICT DO NOTHING;
