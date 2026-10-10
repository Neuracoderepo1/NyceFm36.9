-- 021_innhouse_canonical_reconciliation.sql
--
-- Forward-only, convergent reconciliation of the INNHOUSE schema with the
-- repository's canonical model. Safe to run from EITHER starting state:
--
--   State A  fresh/test database built from this repo (017_innhouse_foundation_schema.sql)
--   State B  production, where Supabase migrations 017-020 were applied instead
--            (see docs/MIGRATION_RECONCILIATION.md and
--             docs/production-snapshots/innhouse-live-017-020.sql)
--
-- What it does NOT do (by design):
--   * It never creates, renames, deletes or rewrites a House, creator, channel,
--     member or station row. All changes are constraints/indexes only.
--   * It never drops or replaces an RLS policy, helper function, or grant, and
--     never disables RLS. The existing policies/grants are left exactly as found.
--   * It never resolves a House by slug. (Production's House is 'nyce-fm'; the repo
--     seed used to say 'nycefm'. That discrepancy is handled in the docs and the
--     017 seed, not by touching data here.)
--
-- Canonical model enforced:
--   * Multiple creators per House; creator handle unique PER HOUSE.
--   * Exactly three House roles: owner, admin, member.
--   * At most ONE active owner per House (DB-level backstop for the app's
--     advisory-lock ownership rules).
--   * houses.house_type in {station, creator, brand, community, organization}.
--   * channels.channel_type in {radio, broadcast, content, community, live, other}.
--   * A legacy station belongs to at most one channel (=> one House): tenant isolation.
--
-- Failure behaviour: the pre-flight block aborts the whole migration (nothing is
-- changed) with a list of every conflicting condition, so an operator can fix the
-- data deliberately. Fail-fast lock_timeout prevents it from queueing behind
-- traffic. Re-running is a no-op in effect (constraints are re-created identically).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Pre-flight: refuse to proceed if existing data would violate the target.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  problems text[] := ARRAY[]::text[];
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.houses
   WHERE house_type NOT IN ('station','creator','brand','community','organization');
  IF n > 0 THEN problems := problems || format('%s house(s) have a house_type outside the canonical set', n); END IF;

  SELECT count(*) INTO n FROM public.channels
   WHERE channel_type NOT IN ('radio','broadcast','content','community','live','other');
  IF n > 0 THEN problems := problems || format('%s channel(s) have a channel_type outside the canonical set', n); END IF;

  SELECT count(*) INTO n FROM public.house_members
   WHERE role NOT IN ('owner','admin','member');
  IF n > 0 THEN problems := problems || format('%s house_members row(s) hold a non-canonical role (editor/moderator); decide a mapping explicitly before migrating', n); END IF;

  SELECT count(*) INTO n FROM (
    SELECT house_id FROM public.house_members
     WHERE role = 'owner' AND status = 'active'
     GROUP BY house_id HAVING count(*) > 1
  ) d;
  IF n > 0 THEN problems := problems || format('%s house(s) have more than one active owner', n); END IF;

  SELECT count(*) INTO n FROM public.creators WHERE handle IS NULL;
  IF n > 0 THEN problems := problems || format('%s creator(s) have a NULL handle', n); END IF;

  SELECT count(*) INTO n FROM (
    SELECT house_id, handle FROM public.creators GROUP BY house_id, handle HAVING count(*) > 1
  ) d;
  IF n > 0 THEN problems := problems || format('%s duplicate (house_id, handle) creator pair(s)', n); END IF;

  SELECT count(*) INTO n FROM (
    SELECT legacy_station_id FROM public.channels
     WHERE legacy_station_id IS NOT NULL
     GROUP BY legacy_station_id HAVING count(*) > 1
  ) d;
  IF n > 0 THEN problems := problems || format('%s legacy station(s) are wrapped by more than one channel', n); END IF;

  -- Security posture guard: never silently inherit write access for API roles.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    IF has_table_privilege('anon', 'public.houses', 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('anon', 'public.creators', 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('anon', 'public.house_members', 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('anon', 'public.channels', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
      problems := problems || 'role anon holds write privileges on an INNHOUSE table';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    IF has_table_privilege('authenticated', 'public.houses', 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('authenticated', 'public.creators', 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('authenticated', 'public.house_members', 'INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('authenticated', 'public.channels', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
      problems := problems || 'role authenticated holds write privileges on an INNHOUSE table';
    END IF;
  END IF;

  IF array_length(problems, 1) IS NOT NULL THEN
    RAISE EXCEPTION '021_innhouse_canonical_reconciliation pre-flight failed: %', array_to_string(problems, '; ');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. houses.house_type: canonical set (superset of live: adds 'station').
-- ---------------------------------------------------------------------------
ALTER TABLE public.houses DROP CONSTRAINT IF EXISTS houses_house_type_check;
ALTER TABLE public.houses ADD CONSTRAINT houses_house_type_check
  CHECK (house_type IN ('station','creator','brand','community','organization'));
ALTER TABLE public.houses ALTER COLUMN house_type SET DEFAULT 'station';

-- ---------------------------------------------------------------------------
-- 3. channels.channel_type: canonical set (superset of live: adds 'radio').
--    Existing 'broadcast' rows are preserved as-is (no data rewrite).
-- ---------------------------------------------------------------------------
ALTER TABLE public.channels DROP CONSTRAINT IF EXISTS channels_channel_type_check;
ALTER TABLE public.channels ADD CONSTRAINT channels_channel_type_check
  CHECK (channel_type IN ('radio','broadcast','content','community','live','other'));
ALTER TABLE public.channels ALTER COLUMN channel_type SET DEFAULT 'radio';

-- ---------------------------------------------------------------------------
-- 4. creators: many per House; handle unique per House (not globally, and not
--    one-creator-per-House as in the live schema).
--    creators.user_id (live-only, nullable FK) is retained: additive, unused by the app.
-- ---------------------------------------------------------------------------
ALTER TABLE public.creators DROP CONSTRAINT IF EXISTS creators_house_id_key;
ALTER TABLE public.creators DROP CONSTRAINT IF EXISTS creators_handle_key;
ALTER TABLE public.creators ALTER COLUMN handle SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.creators'::regclass AND conname = 'creators_house_id_handle_key'
  ) THEN
    ALTER TABLE public.creators ADD CONSTRAINT creators_house_id_handle_key UNIQUE (house_id, handle);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. house_members.role: exactly three canonical roles.
-- ---------------------------------------------------------------------------
ALTER TABLE public.house_members DROP CONSTRAINT IF EXISTS house_members_role_check;
ALTER TABLE public.house_members ADD CONSTRAINT house_members_role_check
  CHECK (role IN ('owner','admin','member'));

-- ---------------------------------------------------------------------------
-- 6. Ownership: at most one ACTIVE owner per House, enforced by the database.
--    (Suspended/removed owner rows do not count. Transfer must demote the old
--    owner before promoting the new one inside its transaction.)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_house_members_one_active_owner
  ON public.house_members (house_id)
  WHERE role = 'owner' AND status = 'active';

-- ---------------------------------------------------------------------------
-- 7. Tenant isolation: a legacy station can be wrapped by at most one channel.
--    Live already has UNIQUE (legacy_station_id); fresh databases did not.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indrelid = 'public.channels'::regclass
       AND i.indisunique
       AND i.indnatts = 1
       AND i.indpred IS NULL
       AND a.attname = 'legacy_station_id'
  ) THEN
    ALTER TABLE public.channels ADD CONSTRAINT channels_legacy_station_id_key UNIQUE (legacy_station_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8. RLS stays ON for every INNHOUSE table (idempotent; no policy is touched).
-- ---------------------------------------------------------------------------
ALTER TABLE public.houses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creators      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.house_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channels      ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 9. Capture two production indexes that exist outside the repo (FK coverage).
--    No-ops on production; closes repo/production drift on fresh databases.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audience_polls_created_by ON public.audience_polls USING btree (created_by);
CREATE INDEX IF NOT EXISTS idx_playlists_created_by      ON public.playlists USING btree (created_by);
