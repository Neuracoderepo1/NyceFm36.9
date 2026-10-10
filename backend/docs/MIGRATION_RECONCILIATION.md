# Migration reconciliation (production vs repo)

Status as of 2026-10-10. Findings come from read-only queries against the
production Supabase project "Nyce Fm" (`qmrqkmddkveoinvspqvn`). Nothing in
production was changed.

## 1. Two migration tracking systems

- Production was migrated through Supabase's own history
  (`supabase_migrations.schema_migrations`, keyed by version + name).
- `npm run migrate` tracks filenames in `public.schema_migrations`.
  **That table does not exist in production.** A plain run would try to replay
  all 17 repo files.
- `migrate.ts` now refuses to run on a database that has Supabase history but
  an empty/missing `public.schema_migrations`. After review, run
  `npm run migrate -- --baseline` once to record the repo files as applied
  without executing any SQL.

## 2. Production history

| Production version(s) | Name | Repo file |
|---|---|---|
| 20260912063210 – 20260913081428 | 001–016 (+ `production_media_ai_hardening`) | 001–016 (`011a` = `production_media_ai_hardening`) |
| 20260914174612 | 017_innhouse_foundation | **differs** from `017_innhouse_foundation_schema.sql` |
| 20260914174643 | 018_restrict_innhouse_rls_helpers | **missing** |
| 20260914174845 | 019_innhouse_foundation_rls | **missing** |
| 20260914174912 | 020_station_tenant_rls | **missing** |
| 20261002104816 – 20261002183356 | 001–016 again (repo filenames, incl. `011a`) | replayed |

Migrations 001–016 appear twice (Sep 12–13 and Oct 2). Both applied without
errors, so they are idempotent in practice, but the second set is a replay and
should not be repeated.

The live SQL for 017–020 is saved for reference in
`docs/production-snapshots/innhouse-live-017-020.sql`. It is deliberately
**not** in `src/db/migrations/`: `018` revokes functions that the repo's `017`
never creates, so adding it as a normal migration would fail on a fresh
database.

## 3. Repo 017 vs live 017 (incompatible)

| | Repo `017_innhouse_foundation_schema.sql` | Live `017_innhouse_foundation` |
|---|---|---|
| Seed House slug | `nycefm` | `nyce-fm` |
| `houses.house_type` | free text, default `station` | CHECK in (`creator`,`brand`,`community`,`organization`), default `creator` |
| `channels.channel_type` | free text, default `radio` | CHECK in (`broadcast`,`content`,`community`,`live`,`other`) |
| `creators` | `UNIQUE (house_id, handle)`, no `user_id` | `UNIQUE (house_id)` (one creator per House), `handle` globally unique, has `user_id` |
| `house_members.role` | owner, admin, member | owner, admin, editor, moderator, member |
| `stations.house_id` | not added | added and backfilled |
| RLS | enabled, no policies, `REVOKE ALL` from anon/authenticated | enabled with policies (public read of active Houses/channels, admin writes) |

Consequences if repo 017 ever ran on production:

- The seed block would insert a second House with slug `nycefm` next to the
  live `nyce-fm`.
- The `REVOKE ALL ... FROM anon, authenticated` would remove access the live
  RLS policies depend on.

## 4. Code and test drift to resolve

- Integration tests build their database from the repo files and insert
  `house_type = 'station'`, which the live CHECK constraint rejects.
- `POST /api/houses/:house/creators` allows multiple creators per House, but the
  live schema allows only one (`UNIQUE (house_id)`).
- Production currently holds 1 House (`nyce-fm`, no owner), 1 channel,
  1 creator, 1 station, **0 users** and 0 house members.

## 5. Decision needed

Pick one source of truth for the INNHOUSE schema:

1. **Live wins.** Rewrite the repo's INNHOUSE migrations to match live 017–020,
   then update the tests and the creators route to fit the live constraints.
2. **Repo wins.** Write a forward-only migration that reshapes the live tables
   (relax the CHECKs and the creators uniqueness, keep the RLS policies), and
   test it on a Supabase branch first.

Either way, test on a disposable branch before touching production.
