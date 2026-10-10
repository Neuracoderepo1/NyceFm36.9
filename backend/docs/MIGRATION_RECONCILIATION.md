# INNHOUSE schema reconciliation (production vs repository)

Status: 2026-10-10. **Decision (owner): the repository model is canonical. Production is
preserved and reconciled by a forward-only migration. Nothing here has been applied to
production.** Production was only ever read (catalog and row queries). All
migration testing ran on an isolated local PostgreSQL 16 database rebuilt from the
production schema.

Companion document: `INNHOUSE_021_DEPLOYMENT_PLAN.md` (impact, deploy, recovery,
bootstrap, blockers).

## 1. How the isolated "production" database was validated

`tests/migration/build-prod-snapshot.sh` builds a database from: the Supabase platform
stub, repo migrations 001–016 (verbatim production), and the **live** INNHOUSE migrations
017–020 (`docs/production-snapshots/innhouse-live-017-020.sql`, read from
`supabase_migrations.schema_migrations`). `tests/migration/fingerprint.sql` hashes seven
catalog categories. The same query was run read-only against live production and against
the snapshot:

| Category | Live (n / md5) | Snapshot |
|---|---|---|
| columns | 314 / `3c68b88e…` | identical |
| constraints | 175 / `0880b8e1…` | identical |
| indexes | 148 / `85840846…` | identical |
| policies | 107 / `95fa0656…` | identical |
| functions (definitions + ACLs) | 15 / `a1f0a49e…` | identical |
| RLS flags | 38 / `46f44791…` | identical |
| INNHOUSE table ACLs | 5 / `22cbe7fc…` | identical |

The hashes are stored in `tests/migration/production-fingerprint.json`, and the
migration suite fails if the snapshot ever drifts from them. Caveats: local Postgres is
16 (production is 17; the only visible effect was the `m` MAINTAIN privilege letter,
normalised away), and the Supabase platform is stubbed.

Discrepancies found while building the snapshot (all reproduced in the builder):
two production indexes that exist in no repo migration
(`idx_audience_polls_created_by`, `idx_playlists_created_by`), and production has
**revoked `authenticated` EXECUTE** on `is_station_house_member/admin` (migration `020`
had granted it; the revoke is in no file I can see).

## 2. Migration tracking and ordering

| | Repo runner (`npm run migrate`) | Production |
|---|---|---|
| Tracker | `public.schema_migrations(filename)` | `supabase_migrations.schema_migrations(version,name)` |
| State | — | `public.schema_migrations` **does not exist** |

- Production history: 001–016 applied Sep 12–13 (name `production_media_ai_hardening` =
  repo `011a`); **017–020 INNHOUSE applied Sep 14**; 001–016 **replayed again Oct 2**
  (idempotent; no errors).
- Repo 001–016 are verified-compatible with production (catalog fingerprint above).
- Repo `017_innhouse_foundation_schema.sql` is **incompatible** with production 017
  (section 4). Live 018–020 have no repo files (kept only as the reference snapshot, because
  `018` revokes functions repo `017` never creates).
- New: `021_innhouse_canonical_reconciliation.sql`. Number 021 avoids colliding with
  production's 018–020 names and sorts after 017. It is convergent from either
  starting state (see 5).
- `migrate.ts` now refuses to run against a database that has Supabase history but an
  empty/missing `public.schema_migrations`, and offers
  `--baseline-through <file>` (bare `--baseline` is refused, because baselining
  "everything" would mark 021 applied and skip it).
- Dependencies: 021 requires `houses, creators, house_members, channels, audience_polls,
  playlists` to exist (any state after 017/live-017 and 001–016).

**The repo migrations cannot simply be baselined through 021.** They can be baselined
through 017 *only because* 021 reconciles the difference; this was rehearsed with the
real runner (see test "deployment rehearsal").

## 3. House slug: `nycefm` vs `nyce-fm` (resolved explicitly)

| Place | Value |
|---|---|
| Production `houses.slug`, `channels.slug`, `creators.handle`, `stations.slug` | `nyce-fm` |
| Repo 017 seed (before this change) | `nycefm` |
| `frontend/innhouse.js` `defaultHouse` (before this change) | `nycefm` → would 404 against production |
| Backend/tests: station lookup `slug='nyce-fm'` | `nyce-fm` |

**Resolution: the canonical slug is `nyce-fm`.** Production data is not renamed and no second
House is created. 021 never resolves or writes a House by slug. Two repo-only edits:
the 017 seed now uses `nyce-fm`, and the frontend default is `nyce-fm`. Tests assert a fresh
database seeds `nyce-fm` and that applying 021 to production-shaped data leaves
exactly one House (`nyce-fm`) with identical row hashes. If any non-production environment
was seeded with the old `nycefm`, that is a deliberate per-environment rename decision, not
something a migration does.

## 4. Schema differences (repo canonical vs live) and what 021 does

| Area | Repo 017 (canonical) | Live 017–020 | 021 result |
|---|---|---|---|
| `houses.house_type` | free text, default `station` | CHECK `creator/brand/community/organization`, default `creator` | CHECK `station/creator/brand/community/organization`; default `station` |
| `houses.timezone` | nullable, no default | NOT NULL default `'UTC'` | unchanged (stricter, harmless; code tolerates both) |
| `channels.channel_type` | free text, default `radio` | CHECK `broadcast/content/community/live/other` | CHECK adds `radio`; default `radio`; existing `broadcast` row kept as is |
| `channels.legacy_station_id` | non-unique partial index | `UNIQUE` | unique ensured on both (a station ↔ one channel ↔ one House) |
| `creators` cardinality | many per House | `UNIQUE (house_id)` (**one**) | dropped |
| `creators.handle` | `UNIQUE (house_id, handle)` | **globally** `UNIQUE (handle)`, nullable | per-House unique, `NOT NULL`; global unique dropped |
| `creators.user_id` | absent | nullable FK | kept (additive, unused by the app) |
| `house_members.role` | `owner/admin/member` | five roles (+`editor`,`moderator`) | exactly three; pre-flight fails if a row holds another |
| Owner uniqueness | app-level advisory lock only | none | **new** partial unique index: one ACTIVE owner per House |
| `stations.house_id` | absent | added + backfilled | kept (additive; production policies in 020 depend on it) |
| Indexes | `idx_*` set | duplicate `*_idx` + `idx_*` set | untouched (redundant duplicates, harmless) |
| Seed House slug | `nycefm` | `nyce-fm` | see section 3 |
| RLS enabled | yes | yes | ensured |
| Policies | **none** (+ `REVOKE ALL FROM anon, authenticated`) | 17 policies on the four tables (houses 3, creators 4, house_members 5, channels 5); 4 on each of 22 station-plane tables; 2 on `stations` | **untouched** |
| Helper functions | none | `current_app_user_id`, `is_house_member/admin`, `is_station_house_member/admin` | untouched |
| Table grants (anon/authenticated) | none | none (only owner + `service_role`) | untouched; pre-flight refuses if either holds write privileges |

Fresh-vs-migrated convergence is tested: after 021 the constraint sets of a freshly built
database and the migrated production snapshot differ only by `creators_user_id_fkey`
(plus cosmetic ordering of a status list, normalised).

## 5. Security posture (preserved, and what it really is)

- RLS is enabled on every INNHOUSE and station-plane table in production; 021 changes no
  policy, function, grant, or RLS flag. A test compares the policy/function/RLS/ACL
  fingerprints before and after.
- **The live policies are currently unreachable.** `anon` and `authenticated` hold no table
  privileges on the INNHOUSE tables, and `authenticated` has no EXECUTE on the helper
  functions, so every direct API-role query fails with `42501` before RLS runs. Effective
  posture = "backend (owner connection) is the only reader/writer", i.e. the same posture as the
  repo's `REVOKE ALL` design. Tests assert `42501` for anon/authenticated on every table.
- The policies are still validated *as written* (inside a rolled-back transaction, with
  temporary grants): a member of House 2 sees only their own membership row; an outsider and
  anon see none; suspended Houses are invisible to anon; a plain member and an admin of
  another House cannot update a House; an admin can add creators to their own House but
  not another's (`42501`); no cross-House role promotion. This guards against a future
  grant turning them on.
- Application authorization (`houseAuth.ts`) is unchanged: House role comes only from an
  active `house_members` row; platform roles never substitute.
- Findings, not changed (need a reviewed security plan): (a) `*_public_read` policies would
  expose active Houses/creators/channels to anon if table SELECT were ever granted;
  (b) the revoke of `authenticated` EXECUTE on `is_station_house_*` is not in any migration
  file; (c) policies reference helper functions that API roles cannot execute (fail closed).

## 6. Creators, roles and ownership (canonical semantics, now enforced)

- Many creators per House; handle unique within a House; same handle allowed in different Houses.
  `GET /api/houses/:house/listener` previously joined `creators` directly (non-deterministic
  row with several creators); it, and the two other public/House read paths, now show the
  earliest creator (`created_at`, `id`). A test fails against the old query.
- Three roles: owner, admin, member. `owner` is never settable through the member routes.
- Ownership: transfer and bootstrap keep the advisory lock and in-lock re-checks, and the
  database now guarantees at most one active owner. Transfer demotes the outgoing owner
  **before** promoting the incoming one (the unique index is not deferrable). A concurrent
  race that hits the index returns `409 OWNER_STATE_CHANGED` / `HOUSE_ALREADY_HAS_OWNER`.
- `creators` unique-violation mapping is by constraint name (`creators_house_id_handle_key`),
  so unrelated 23505s are not reported as "handle taken".

## 7. Production records (read-only inspection, 2026-10-10)

1 House `nyce-fm` (type `creator`, active, timezone `UTC`, **0 owners**), 1 creator
(`nyce-fm`, founding creator), 1 channel (`nyce-fm`, `broadcast`, linked to the single
station), 1 station, **0 users, 0 house members**; roles table seeded with 7 platform roles.
No orphaned or duplicate rows exist, so no data repair is required.

## 8. Test evidence (all on isolated local databases)

| Suite | Command | Result |
|---|---|---|
| Existing + new integration (fresh DB: repo 001–017 + 021) | `npm test` | 89 / 89 pass (70 pre-existing, 19 new in `inn-009`) |
| Production rehearsal (snapshot DB) | `npm run test:migration` | 22 / 22 pass |
| Type check, build | `npm run typecheck`, `npm run build` | clean |

Rehearsal covers: snapshot fidelity vs live; data unchanged (row hashes); policies/functions/
RLS/ACLs unchanged; second run is a no-op; canonical behaviour (multi-creator, roles, types,
single owner, transfer ordering); convergence with a fresh database; anon/authenticated
denial and policy tenant isolation; atomic failure (conflicting data → nothing changes → fix →
success); privilege guard; `lock_timeout` fail-fast then success; the real runner flow
(refuse replay → refuse bare baseline → baseline through 017 → apply only 021 → idempotent);
forward-recovery script restoring the exact production fingerprint, and refusing once data
uses the canonical model. One negative control was run: the listener-ordering test fails against the old query and
passes with the fix (its first draft was too weak to catch the bug and was strengthened).
