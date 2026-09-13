-- TEST-ENVIRONMENT ONLY SHIM.
--
-- This file exists solely so that the real production migrations in
-- src/db/migrations/** (which target Supabase-managed Postgres) can also
-- apply cleanly against a vanilla Postgres instance in CI / local dev.
--
-- It stubs the minimum subset of Supabase's platform schema that our
-- migrations touch:
--   - the `storage` schema and `storage.buckets` table (migration 008)
--   - the `supabase_realtime` publication (migration 008)
--   - the `anon` / `authenticated` / `service_role` roles (migrations 007, 014)
--
-- DO NOT run this against a real Supabase project. Real Supabase projects
-- already provide all of this natively; running this stub there would be
-- redundant at best and could conflict with the platform's own managed
-- objects at worst. This file is only ever invoked by the local test
-- bootstrap (see tests/helpers/db.ts) against TEST_DATABASE_URL, which is
-- guarded to refuse anything that looks like a production Supabase host.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public BOOLEAN NOT NULL DEFAULT false,
  file_size_limit BIGINT,
  allowed_mime_types TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id TEXT REFERENCES storage.buckets(id),
  name TEXT,
  owner UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;
