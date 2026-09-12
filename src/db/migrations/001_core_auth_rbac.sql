-- 001_core_auth_rbac.sql
-- Foundation schema: users, roles, RBAC, stations, audit log.
-- Every migration is additive/forward-only; rollback = restore from backup + re-run up to N-1.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  failed_login_count SMALLINT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  id          SMALLSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE, -- LISTENER, DJ, PRODUCER, MODERATOR, EDITOR, ADMIN, SUPER_ADMIN
  description TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
  id    SMALLSERIAL PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE -- e.g. broadcast.control, library.upload
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       SMALLINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id SMALLINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id SMALLINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by UUID REFERENCES users(id),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS stations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'UTC',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS station_settings (
  station_id  UUID PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable audit trail. Application must never UPDATE/DELETE rows here.
CREATE TABLE IF NOT EXISTS audit_events (
  id              BIGSERIAL PRIMARY KEY,
  actor_id        UUID REFERENCES users(id),
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  before_state    JSONB,
  after_state     JSONB,
  ip_address      INET,
  correlation_id  UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id          BIGSERIAL PRIMARY KEY,
  email       CITEXT NOT NULL,
  ip_address  INET,
  success     BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time ON login_attempts(email, created_at);

-- Seed roles + baseline permission set
INSERT INTO roles (name, description) VALUES
  ('LISTENER','Public listener'),
  ('DJ','On-air talent'),
  ('PRODUCER','Programming/production staff'),
  ('MODERATOR','Chat/content moderation'),
  ('EDITOR','Library/playlist editor'),
  ('ADMIN','Station administrator'),
  ('SUPER_ADMIN','Platform super administrator')
ON CONFLICT (name) DO NOTHING;

INSERT INTO permissions (code) VALUES
  ('broadcast.read'),('broadcast.control'),
  ('queue.read'),('queue.modify'),
  ('library.read'),('library.upload'),
  ('playlist.read'),('playlist.modify'),
  ('ai.read'),('ai.configure'),('ai.approve'),
  ('moderation.read'),('moderation.execute'),
  ('analytics.read'),
  ('payments.read'),('payments.manage'),
  ('system.read'),('system.configure'),
  ('audit.read'),
  ('users.manage')
ON CONFLICT (code) DO NOTHING;

-- SUPER_ADMIN gets everything
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.name = 'SUPER_ADMIN'
ON CONFLICT DO NOTHING;

-- ADMIN gets everything except users.manage (reserved for SUPER_ADMIN)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'ADMIN' AND p.code <> 'users.manage'
ON CONFLICT DO NOTHING;

-- MODERATOR
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'MODERATOR' AND p.code IN ('moderation.read','moderation.execute','broadcast.read')
ON CONFLICT DO NOTHING;

-- EDITOR
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'EDITOR' AND p.code IN ('library.read','library.upload','playlist.read','playlist.modify')
ON CONFLICT DO NOTHING;

-- LISTENER: no privileged permissions
