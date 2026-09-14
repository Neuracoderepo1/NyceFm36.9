-- 017_innhouse_foundation_schema.sql
-- INN-004: schema for the INNHOUSE tenancy model introduced by INN-003
-- (backend/src/routes/innhouse.ts). Additive only -- no existing table is
-- altered, and no legacy station/broadcast data is migrated or duplicated.
--
-- Model: INNHOUSE -> House -> Creator / Members / Channels -> Platform Modules
-- NYCE FM becomes the first House, wrapping the existing `stations` row via
-- channels.legacy_station_id (read-only linkage, per INN-003's security intent
-- of never resolving a legacy record independently of the resolved House).

CREATE TABLE IF NOT EXISTS houses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  house_type  TEXT NOT NULL DEFAULT 'station',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  timezone    TEXT,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS house_members (
  house_id    UUID NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended', 'removed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (house_id, user_id)
);

CREATE TABLE IF NOT EXISTS creators (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  house_id      UUID NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  handle        TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  bio           TEXT,
  avatar_key    TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  house_id            UUID NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  slug                TEXT NOT NULL,
  name                TEXT NOT NULL,
  channel_type        TEXT NOT NULL DEFAULT 'radio',
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  legacy_station_id   UUID REFERENCES stations(id) ON DELETE SET NULL,
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (house_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_house_members_user ON house_members (user_id);
CREATE INDEX IF NOT EXISTS idx_creators_house ON creators (house_id);
CREATE INDEX IF NOT EXISTS idx_channels_house ON channels (house_id);
CREATE INDEX IF NOT EXISTS idx_channels_legacy_station ON channels (legacy_station_id) WHERE legacy_station_id IS NOT NULL;

-- Same RLS posture as every other application table (see
-- 007_production_rls_hardening.sql): RLS is enabled so PostgREST's anon /
-- authenticated roles have no path in, but no policies are defined because
-- the application's own DB connection (table owner) is the sole writer and
-- enforces authorization itself -- exactly what innhouse.ts's resolveHouse()
-- does before returning any row.
ALTER TABLE houses ENABLE ROW LEVEL SECURITY;
ALTER TABLE house_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE creators ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON houses, house_members, creators, channels FROM anon, authenticated;

-- Seed: NYCE FM becomes House #1, wrapping the existing default station.
-- Idempotent (ON CONFLICT DO NOTHING) so re-running this migration, or
-- running it after a manual seed, is safe.
DO $$
DECLARE
  v_house_id UUID;
  v_station_id UUID;
  v_owner_user_id UUID;
BEGIN
  INSERT INTO houses (slug, name, house_type, status, timezone)
  VALUES ('nycefm', 'NYCE FM', 'station', 'active', 'UTC')
  ON CONFLICT (slug) DO NOTHING;

  SELECT id INTO v_house_id FROM houses WHERE slug = 'nycefm';

  -- Wrap the existing (first-created) legacy station as this House's
  -- primary channel, if one exists and isn't already wrapped.
  SELECT id INTO v_station_id FROM stations ORDER BY created_at ASC LIMIT 1;

  IF v_station_id IS NOT NULL THEN
    INSERT INTO channels (house_id, slug, name, channel_type, status, legacy_station_id)
    SELECT v_house_id, s.slug, s.name, 'radio', 'active', s.id
      FROM stations s
     WHERE s.id = v_station_id
    ON CONFLICT (house_id, slug) DO NOTHING;
  END IF;

  -- Grant House ownership to whichever user currently holds the
  -- SUPER_ADMIN or ADMIN role, so at least one member can access
  -- /api/houses/nycefm immediately after this migration runs.
  SELECT ur.user_id INTO v_owner_user_id
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
   WHERE r.name IN ('SUPER_ADMIN', 'ADMIN')
   ORDER BY ur.granted_at ASC
   LIMIT 1;

  IF v_owner_user_id IS NOT NULL THEN
    INSERT INTO house_members (house_id, user_id, role, status)
    VALUES (v_house_id, v_owner_user_id, 'owner', 'active')
    ON CONFLICT (house_id, user_id) DO NOTHING;
  END IF;
END $$;
