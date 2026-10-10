-- 021 DOWN -- FORWARD-RECOVERY SCRIPT. NOT a migration; never placed in src/db/migrations/.
--
-- Restores the exact production (live 017-020) constraint/index/default shape that
-- existed before 021. Verified by tests/migration/production-snapshot.test.ts: after
-- 021 + this script the isolated snapshot's catalog fingerprint equals production's.
--
-- Only valid while no data depends on the canonical rules. Each re-added constraint
-- is checked up front; if any row violates the legacy rule the script aborts with
-- an explanation and changes nothing (single transaction; run with psql --single-transaction
-- or inside BEGIN/COMMIT). Preferred recovery in most cases is to fix forward instead.
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE problems text[] := ARRAY[]::text[]; n bigint;
BEGIN
  SELECT count(*) INTO n FROM (SELECT house_id FROM public.creators GROUP BY house_id HAVING count(*) > 1) d;
  IF n > 0 THEN problems := problems || format('%s house(s) have more than one creator (legacy allows one)', n); END IF;
  SELECT count(*) INTO n FROM (SELECT handle FROM public.creators GROUP BY handle HAVING count(*) > 1) d;
  IF n > 0 THEN problems := problems || format('%s creator handle(s) are used in more than one House (legacy requires global uniqueness)', n); END IF;
  SELECT count(*) INTO n FROM public.houses WHERE house_type = 'station';
  IF n > 0 THEN problems := problems || format('%s house(s) have house_type station (not allowed by legacy)', n); END IF;
  SELECT count(*) INTO n FROM public.channels WHERE channel_type = 'radio';
  IF n > 0 THEN problems := problems || format('%s channel(s) have channel_type radio (not allowed by legacy)', n); END IF;
  IF array_length(problems, 1) IS NOT NULL THEN
    RAISE EXCEPTION '021 down aborted, data uses the canonical model: %', array_to_string(problems, '; ');
  END IF;
END $$;

DROP INDEX IF EXISTS public.uq_house_members_one_active_owner;

ALTER TABLE public.house_members DROP CONSTRAINT IF EXISTS house_members_role_check;
ALTER TABLE public.house_members ADD CONSTRAINT house_members_role_check
  CHECK (role IN ('owner','admin','editor','moderator','member'));

ALTER TABLE public.creators DROP CONSTRAINT IF EXISTS creators_house_id_handle_key;
ALTER TABLE public.creators ADD CONSTRAINT creators_house_id_key UNIQUE (house_id);
ALTER TABLE public.creators ADD CONSTRAINT creators_handle_key UNIQUE (handle);
ALTER TABLE public.creators ALTER COLUMN handle DROP NOT NULL;

ALTER TABLE public.channels DROP CONSTRAINT IF EXISTS channels_channel_type_check;
ALTER TABLE public.channels ADD CONSTRAINT channels_channel_type_check
  CHECK (channel_type IN ('broadcast','content','community','live','other'));
ALTER TABLE public.channels ALTER COLUMN channel_type DROP DEFAULT;

ALTER TABLE public.houses DROP CONSTRAINT IF EXISTS houses_house_type_check;
ALTER TABLE public.houses ADD CONSTRAINT houses_house_type_check
  CHECK (house_type IN ('creator','brand','community','organization'));
ALTER TABLE public.houses ALTER COLUMN house_type SET DEFAULT 'creator';
-- (idx_audience_polls_created_by / idx_playlists_created_by exist in production; left in place.)
