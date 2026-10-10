-- READ-ONLY REFERENCE SNAPSHOT -- NOT a runnable migration.
-- Do not move this file into src/db/migrations/.
--
-- Captured 2026-10-10 from production Supabase project "Nyce Fm"
-- (qmrqkmddkveoinvspqvn), supabase_migrations.schema_migrations.
-- These four migrations are applied in production but have no counterpart
-- in src/db/migrations/ (the repo's 017_innhouse_foundation_schema.sql is a
-- DIFFERENT, incompatible definition -- see docs/MIGRATION_RECONCILIATION.md).

-- =====================================================================
-- 20260914174612  017_innhouse_foundation
-- =====================================================================
begin;

create table if not exists public.houses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  house_type text not null default 'creator' check (house_type in ('creator','brand','community','organization')),
  status text not null default 'active' check (status in ('active','suspended','archived')),
  timezone text not null default 'UTC',
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.creators (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null unique references public.houses(id) on delete cascade,
  user_id uuid null references public.users(id) on delete set null,
  handle text unique,
  display_name text not null,
  bio text,
  avatar_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.house_members (
  house_id uuid not null references public.houses(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','editor','moderator','member')),
  status text not null default 'active' check (status in ('invited','active','suspended','removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (house_id, user_id)
);

create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references public.houses(id) on delete cascade,
  slug text not null,
  name text not null,
  channel_type text not null check (channel_type in ('broadcast','content','community','live','other')),
  status text not null default 'active' check (status in ('active','paused','archived')),
  legacy_station_id uuid null unique references public.stations(id) on delete set null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (house_id, slug)
);

create index if not exists houses_status_idx on public.houses(status);
create index if not exists creators_house_id_idx on public.creators(house_id);
create index if not exists house_members_user_id_idx on public.house_members(user_id);
create index if not exists channels_house_id_idx on public.channels(house_id);

-- Establish the first platform tenant from the existing NYCE FM station without renaming or moving legacy data.
insert into public.houses (slug, name, house_type, status, timezone)
select s.slug, s.name, 'creator', 'active', s.timezone
from public.stations s
where s.slug = 'nyce-fm'
on conflict (slug) do nothing;

insert into public.channels (house_id, slug, name, channel_type, status, legacy_station_id)
select h.id, s.slug, s.name, 'broadcast', 'active', s.id
from public.houses h
join public.stations s on s.slug = h.slug
where h.slug = 'nyce-fm'
on conflict (legacy_station_id) do nothing;

insert into public.creators (house_id, display_name, handle, metadata)
select h.id, h.name, h.slug, jsonb_build_object('source','nyce_fm_migration','role','founding_creator')
from public.houses h
where h.slug = 'nyce-fm'
  and not exists (select 1 from public.creators c where c.house_id = h.id);

-- Add a nullable house boundary to the legacy station table. Existing station behavior remains unchanged.
alter table public.stations add column if not exists house_id uuid references public.houses(id) on delete set null;
update public.stations s
set house_id = h.id
from public.houses h
where h.slug = s.slug
  and s.house_id is null;
create index if not exists stations_house_id_idx on public.stations(house_id);

-- Reusable authorization helpers for future Supabase-authenticated callers.
create or replace function public.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  where nullif(current_setting('request.jwt.claim.sub', true), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
$$;

create or replace function public.is_house_member(p_house_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.house_members hm
    where hm.house_id = p_house_id
      and hm.user_id = public.current_app_user_id()
      and hm.status = 'active'
  );
$$;

create or replace function public.is_house_admin(p_house_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.house_members hm
    where hm.house_id = p_house_id
      and hm.user_id = public.current_app_user_id()
      and hm.status = 'active'
      and hm.role in ('owner','admin')
  );
$$;

-- New platform tables are RLS protected from the outset. The legacy station plane remains compatibility/service-role controlled.
alter table public.houses enable row level security;
alter table public.creators enable row level security;
alter table public.house_members enable row level security;
alter table public.channels enable row level security;

drop policy if exists houses_member_select on public.houses;
create policy houses_member_select on public.houses
for select to authenticated
using (public.is_house_member(id));

drop policy if exists creators_member_select on public.creators;
create policy creators_member_select on public.creators
for select to authenticated
using (public.is_house_member(house_id));

drop policy if exists house_members_self_or_admin_select on public.house_members;
create policy house_members_self_or_admin_select on public.house_members
for select to authenticated
using (user_id = public.current_app_user_id() or public.is_house_admin(house_id));

drop policy if exists channels_member_select on public.channels;
create policy channels_member_select on public.channels
for select to authenticated
using (public.is_house_member(house_id));

-- Public discovery is deliberately not enabled yet. Public creator/fan reads will be introduced only with explicit visibility columns and policies.

commit;

-- =====================================================================
-- 20260914174643  018_restrict_innhouse_rls_helpers
-- =====================================================================
revoke execute on function public.current_app_user_id() from public, anon, authenticated;
revoke execute on function public.is_house_member(uuid) from public, anon, authenticated;
revoke execute on function public.is_house_admin(uuid) from public, anon, authenticated;

-- =====================================================================
-- 20260914174845  019_innhouse_foundation_rls
-- =====================================================================
-- INNHOUSE foundation security layer.
-- Additive only: preserves the existing NYCE FM service-role backend and legacy schema.

ALTER TABLE public.houses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.house_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS houses_public_read ON public.houses;
CREATE POLICY houses_public_read ON public.houses
  FOR SELECT TO anon, authenticated
  USING (status = 'active');

DROP POLICY IF EXISTS houses_member_update ON public.houses;
CREATE POLICY houses_member_update ON public.houses
  FOR UPDATE TO authenticated
  USING (public.is_house_admin(id))
  WITH CHECK (public.is_house_admin(id));

DROP POLICY IF EXISTS creators_public_read ON public.creators;
CREATE POLICY creators_public_read ON public.creators
  FOR SELECT TO anon, authenticated
  USING (EXISTS (SELECT 1 FROM public.houses h WHERE h.id = creators.house_id AND h.status = 'active'));

DROP POLICY IF EXISTS creators_admin_insert ON public.creators;
CREATE POLICY creators_admin_insert ON public.creators
  FOR INSERT TO authenticated
  WITH CHECK (public.is_house_admin(house_id));

DROP POLICY IF EXISTS creators_admin_update ON public.creators;
CREATE POLICY creators_admin_update ON public.creators
  FOR UPDATE TO authenticated
  USING (public.is_house_admin(house_id))
  WITH CHECK (public.is_house_admin(house_id));

DROP POLICY IF EXISTS house_members_self_or_admin_read ON public.house_members;
CREATE POLICY house_members_self_or_admin_read ON public.house_members
  FOR SELECT TO authenticated
  USING (user_id = public.current_app_user_id() OR public.is_house_admin(house_id));

DROP POLICY IF EXISTS house_members_admin_insert ON public.house_members;
CREATE POLICY house_members_admin_insert ON public.house_members
  FOR INSERT TO authenticated
  WITH CHECK (public.is_house_admin(house_id));

DROP POLICY IF EXISTS house_members_admin_update ON public.house_members;
CREATE POLICY house_members_admin_update ON public.house_members
  FOR UPDATE TO authenticated
  USING (public.is_house_admin(house_id))
  WITH CHECK (public.is_house_admin(house_id));

DROP POLICY IF EXISTS house_members_admin_delete ON public.house_members;
CREATE POLICY house_members_admin_delete ON public.house_members
  FOR DELETE TO authenticated
  USING (public.is_house_admin(house_id));

DROP POLICY IF EXISTS channels_public_read ON public.channels;
CREATE POLICY channels_public_read ON public.channels
  FOR SELECT TO anon, authenticated
  USING (status = 'active' AND EXISTS (SELECT 1 FROM public.houses h WHERE h.id = channels.house_id AND h.status = 'active'));

DROP POLICY IF EXISTS channels_admin_insert ON public.channels;
CREATE POLICY channels_admin_insert ON public.channels
  FOR INSERT TO authenticated
  WITH CHECK (public.is_house_admin(house_id));

DROP POLICY IF EXISTS channels_admin_update ON public.channels;
CREATE POLICY channels_admin_update ON public.channels
  FOR UPDATE TO authenticated
  USING (public.is_house_admin(house_id))
  WITH CHECK (public.is_house_admin(house_id));

DROP POLICY IF EXISTS channels_admin_delete ON public.channels;
CREATE POLICY channels_admin_delete ON public.channels
  FOR DELETE TO authenticated
  USING (public.is_house_admin(house_id));

-- Indexes supporting the tenant boundary and resolver path.
CREATE INDEX IF NOT EXISTS idx_house_members_user_status ON public.house_members(user_id, status);
CREATE INDEX IF NOT EXISTS idx_house_members_house_status ON public.house_members(house_id, status);
CREATE INDEX IF NOT EXISTS idx_creators_house ON public.creators(house_id);
CREATE INDEX IF NOT EXISTS idx_channels_house_status ON public.channels(house_id, status);
CREATE INDEX IF NOT EXISTS idx_stations_house ON public.stations(house_id);

COMMENT ON TABLE public.houses IS 'INNHOUSE tenant boundary. A creator-owned digital home/community.';
COMMENT ON TABLE public.creators IS 'INNHOUSE creator identity associated with a House.';
COMMENT ON TABLE public.house_members IS 'House-scoped authorization membership for INNHOUSE.';
COMMENT ON TABLE public.channels IS 'House-scoped audience/content channels; broadcast channels may bridge legacy stations.';
COMMENT ON COLUMN public.stations.house_id IS 'Compatibility bridge: legacy NYCE FM station mapped into an INNHOUSE House.';

-- =====================================================================
-- 20260914174912  020_station_tenant_rls
-- =====================================================================
-- Tenant enforcement for the legacy NYCE FM station-shaped data plane.
-- All existing application writes continue through the service-role backend.

CREATE OR REPLACE FUNCTION public.is_station_house_member(p_station_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.stations s
    JOIN public.house_members hm ON hm.house_id = s.house_id
    WHERE s.id = p_station_id
      AND hm.user_id = public.current_app_user_id()
      AND hm.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_station_house_admin(p_station_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.stations s
    JOIN public.house_members hm ON hm.house_id = s.house_id
    WHERE s.id = p_station_id
      AND hm.user_id = public.current_app_user_id()
      AND hm.status = 'active'
      AND hm.role IN ('owner','admin')
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_station_house_member(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_station_house_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_station_house_member(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_station_house_admin(uuid) TO authenticated, service_role;

ALTER TABLE public.stations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stations_member_read ON public.stations;
CREATE POLICY stations_member_read ON public.stations
  FOR SELECT TO authenticated USING (public.is_station_house_member(id));
DROP POLICY IF EXISTS stations_admin_update ON public.stations;
CREATE POLICY stations_admin_update ON public.stations
  FOR UPDATE TO authenticated
  USING (public.is_station_house_admin(id))
  WITH CHECK (public.is_station_house_admin(id));

DO $$
DECLARE t text;
DECLARE tables text[] := ARRAY['ai_actions','ai_runs','ai_station_config','ai_voice_segments','audience_events','audience_messages','audience_polls','broadcast_incidents','broadcast_overrides','broadcast_programs','broadcast_queue','broadcast_schedules','broadcast_sessions','dedications','listener_presence','listener_reactions','listener_requests','media_assets','now_playing','playlists','station_settings','stream_events'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_house_member_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_station_house_member(station_id))', t || '_house_member_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_house_admin_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.is_station_house_admin(station_id))', t || '_house_admin_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_house_admin_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.is_station_house_admin(station_id)) WITH CHECK (public.is_station_house_admin(station_id))', t || '_house_admin_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_house_admin_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.is_station_house_admin(station_id))', t || '_house_admin_delete', t);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_stations_house_id ON public.stations(house_id);
COMMENT ON FUNCTION public.is_station_house_member(uuid) IS 'Tenant boundary resolver for legacy station resources.';
COMMENT ON FUNCTION public.is_station_house_admin(uuid) IS 'Administrative tenant boundary resolver for legacy station resources.';
