#!/usr/bin/env bash
# Builds an ISOLATED database that reproduces production's schema:
#   Supabase platform stub + repo migrations 001-016 (verbatim production)
#   + live INNHOUSE migrations 017-020 (docs/production-snapshots).
# The repo's own 017_innhouse_foundation_schema.sql is deliberately NOT applied.
# Usage: build-prod-snapshot.sh <dbname>   (local Postgres only; never a Supabase host)
set -euo pipefail
DB="${1:-nycefm_prodsnap}"
HOST="${PGHOST:-localhost}"
case "$HOST" in *supabase*) echo "refusing: Supabase host"; exit 1;; esac
export PGPASSWORD="${PGPASSWORD:-postgres}"
P="psql -h $HOST -U ${PGUSER:-postgres} -v ON_ERROR_STOP=1 -q"
HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$HERE/../.."
$P -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
S="$P -d $DB"
$S -f "$HERE/../helpers/supabase-platform-stub.sql" 2>&1 | grep -v -E "WARNING|HINT" || true
# Production ACLs on the INNHOUSE tables show only owner + service_role grants.
$S -c "ALTER DEFAULT PRIVILEGES FOR ROLE ${PGUSER:-postgres} IN SCHEMA public GRANT ALL ON TABLES TO service_role" -c "ALTER DEFAULT PRIVILEGES FOR ROLE ${PGUSER:-postgres} IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role"
# Only migrations BEFORE 017 are production's repo-tracked history. 017 (repo version) and
# anything after it (e.g. 021) are what is being rehearsed and must NOT be pre-applied.
for f in $(ls "$BACKEND"/src/db/migrations/*.sql | sort); do
  b="$(basename "$f")"
  if [[ "$b" < "017_" ]]; then $S -f "$f" >/dev/null; fi
done
$S -f "$BACKEND/docs/production-snapshots/innhouse-live-017-020.sql" >/dev/null
# Observed in production ACLs, source not in any migration file: authenticated has no EXECUTE
# on is_station_house_member/admin (migration 020 had granted it).
$S -c "REVOKE EXECUTE ON FUNCTION public.is_station_house_member(uuid) FROM authenticated" -c "REVOKE EXECUTE ON FUNCTION public.is_station_house_admin(uuid) FROM authenticated"
# Two production indexes that exist outside the repo (found by catalog diff, 2026-10-10).
$S -c "CREATE INDEX IF NOT EXISTS idx_audience_polls_created_by ON public.audience_polls USING btree (created_by)" -c "CREATE INDEX IF NOT EXISTS idx_playlists_created_by ON public.playlists USING btree (created_by)"
echo "built $DB"
