-- Phase 3: Listener & Audience Platform
CREATE TABLE IF NOT EXISTS listener_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_key TEXT,
  bio TEXT,
  is_public BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listener_presence (
  id BIGSERIAL PRIMARY KEY,
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_listener_presence_station_live ON listener_presence(station_id,last_seen_at) WHERE disconnected_at IS NULL;

CREATE TABLE IF NOT EXISTS listener_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id TEXT,
  media_asset_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  requested_title TEXT,
  requested_artist TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','queued','played','rejected','cancelled')),
  moderation_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL),
  CHECK (media_asset_id IS NOT NULL OR requested_title IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_listener_requests_station_status ON listener_requests(station_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS dedications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id TEXT,
  recipient_name TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','read','rejected')),
  moderation_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_dedications_station_status ON dedications(station_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS listener_reactions (
  id BIGSERIAL PRIMARY KEY,
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id TEXT,
  reaction TEXT NOT NULL CHECK (reaction IN ('like','love','fire','dance','wow')),
  media_asset_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_listener_reactions_station_time ON listener_reactions(station_id,created_at DESC);

CREATE TABLE IF NOT EXISTS audience_polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audience_poll_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id UUID NOT NULL REFERENCES audience_polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  UNIQUE(poll_id,position)
);
CREATE TABLE IF NOT EXISTS audience_poll_votes (
  id BIGSERIAL PRIMARY KEY,
  poll_id UUID NOT NULL REFERENCES audience_polls(id) ON DELETE CASCADE,
  option_id UUID NOT NULL REFERENCES audience_poll_options(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_poll_vote_user ON audience_poll_votes(poll_id,user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_poll_vote_anon ON audience_poll_votes(poll_id,anonymous_id) WHERE anonymous_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS audience_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id TEXT,
  display_name TEXT NOT NULL,
  body TEXT NOT NULL CHECK(char_length(body) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'visible' CHECK(status IN ('visible','hidden','deleted')),
  moderated_by UUID REFERENCES users(id),
  moderated_at TIMESTAMPTZ,
  moderation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_audience_messages_station_created ON audience_messages(station_id,created_at DESC);

CREATE TABLE IF NOT EXISTS audience_events (
  id BIGSERIAL PRIMARY KEY,
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL OR event_type IN ('station_snapshot','stream_snapshot'))
);
CREATE INDEX IF NOT EXISTS idx_audience_events_station_time ON audience_events(station_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audience_events_type_time ON audience_events(event_type,occurred_at DESC);

INSERT INTO permissions(code) VALUES ('audience.read'),('audience.moderate'),('audience.configure') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name='MODERATOR' AND p.code IN ('audience.read','audience.moderate') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name='ADMIN' AND p.code IN ('audience.read','audience.moderate','audience.configure') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name='SUPER_ADMIN' AND p.code IN ('audience.read','audience.moderate','audience.configure') ON CONFLICT DO NOTHING;
