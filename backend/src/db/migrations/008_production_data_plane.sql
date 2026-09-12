-- Production data-plane baseline: private media storage, deterministic timestamps, and Realtime.
INSERT INTO storage.buckets(id,name,public,file_size_limit)
VALUES('nycefm-media','nycefm-media',false,104857600)
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=EXCLUDED.file_size_limit;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM public, anon, authenticated;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='updated_at' LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON public.%I', r.table_name, r.table_name);
    EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', r.table_name, r.table_name);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='now_playing') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.now_playing; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='broadcast_queue') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.broadcast_queue; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='listener_presence') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.listener_presence; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='audience_events') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.audience_events; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='ai_actions') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_actions; END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_broadcast_active_override ON public.broadcast_overrides(station_id) WHERE active=true;
CREATE UNIQUE INDEX IF NOT EXISTS ux_poll_vote_user ON public.audience_poll_votes(poll_id,user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_poll_vote_anon ON public.audience_poll_votes(poll_id,anonymous_id) WHERE anonymous_id IS NOT NULL;
