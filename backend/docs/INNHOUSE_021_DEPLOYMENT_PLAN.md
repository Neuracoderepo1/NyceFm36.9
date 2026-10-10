# Migration 021: data impact, deployment, recovery, owner bootstrap, blockers

**Nothing here is authorized yet.** Production execution requires separate, explicit approval
after review of this plan and the security notes in `MIGRATION_RECONCILIATION.md`.

## 1. Production data-impact assessment

| Aspect | Impact |
|---|---|
| Rows | **None** created, changed or deleted (verified by row-hash equality, 5 tables) |
| Houses | Still exactly one, `nyce-fm`; no rename, no duplicate |
| Schema | 5 constraints replaced/added (`houses_house_type_check`, `channels_channel_type_check`, `house_members_role_check`, `creators_house_id_handle_key` added; `creators_house_id_key`, `creators_handle_key` dropped), 1 index added, 2 column defaults, `creators.handle NOT NULL` |
| Policies / functions / grants / RLS | Unchanged (fingerprint-verified) |
| Locking | Short `ACCESS EXCLUSIVE` locks on 4 tiny tables (1 row each); `lock_timeout = 5s` makes it fail fast instead of queueing behind traffic |
| Downtime / app impact | None expected; the current app code is compatible with the schema both before and after |
| Reversibility | Scripted forward-recovery; exact-fingerprint restore proven while no data uses the canonical model |

The app releases that accompany this (transfer ordering, listener query, creator error
mapping, frontend default slug) work on the schema **both before and after** 021, so merge
order does not matter. (Before 021 a second creator is still impossible and would surface as a
server error rather than the friendly 409. That is the existing production behaviour.) If Render
auto-deploys from `main` (not verified here, so check), the code goes live on merge.

## 2. Pre-migration checks (read-only, run immediately before)

1. CI green on the PR for **both** suites (`npm test` needs Postgres + Redis; `npm run test:migration` needs `psql` and a local Postgres).
2. Re-run `tests/migration/fingerprint.sql` on production; all 7 hashes must still equal
   `tests/migration/production-fingerprint.json`. Any difference means production drifted since
   2026-10-10. Stop and re-reconcile.
3. Data shape (expect 1/1/1/0/0 and zero rows from the last two):
   ```sql
   select (select count(*) from houses) houses, (select count(*) from creators) creators,
          (select count(*) from channels) channels, (select count(*) from house_members) members,
          (select count(*) from users) users;
   select house_id from house_members where role='owner' and status='active' group by 1 having count(*)>1;
   select * from house_members where role not in ('owner','admin','member');
   ```
4. Privileges: `select has_table_privilege(r,t,'INSERT,UPDATE,DELETE') from unnest(array['anon','authenticated']) r, unnest(array['public.houses','public.creators','public.house_members','public.channels']) t;` all false.
5. No long-running transactions on those tables (`pg_stat_activity`).
6. A restorable backup/PITR point exists (Supabase dashboard). Record its timestamp.
7. Optional but recommended: rehearse once on a Supabase **branch** of the project (real platform roles and PG 17). Branching may be a paid feature; it was not used.

## 3. Deployment (when authorized)

Use the real runner path, the one that was rehearsed end to end:

1. `DATABASE_URL=<prod> npm run migrate` → expect `Refusing to migrate` (guard works).
2. `npm run migrate -- --baseline-through 017_innhouse_foundation_schema.sql` → records 001–017 repo files as applied, **runs no SQL**, prints that `021…` is still pending.
3. `npm run migrate` → applies only `021_innhouse_canonical_reconciliation.sql` in one transaction.
4. Repeat step 3 → all `skip`.

Note: Supabase's own `supabase_migrations` list will not show 021 when applied this way.
If you prefer Supabase's migration tooling instead, apply the SQL as one transaction and then run
`--baseline-through 021_innhouse_canonical_reconciliation.sql`; confirm first that the tool runs the
file in a transaction, since `SET LOCAL lock_timeout` depends on it.

## 4. Post-migration verification

- Fingerprint: `policies`, `functions`, `rls`, `table_acl_innhouse` hashes unchanged; `constraints` changed; `indexes` count unchanged (148).
- Data hashes/counts unchanged; `select slug from houses` → only `nyce-fm`.
- `select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid in ('creators'::regclass,'house_members'::regclass,'houses'::regclass,'channels'::regclass) order by 1;` matches section 4 of the reconciliation.
- `select indexname from pg_indexes where indexname='uq_house_members_one_active_owner';`
- App: `/health/ready` healthy; `GET /api/houses/nyce-fm/public` returns the House with its creator and channel (this is also the check that the frontend's new default slug resolves).

## 5. Failure and recovery

- **Failure during apply:** single transaction → nothing is changed. The pre-flight lists every
  conflicting condition (non-canonical role, two active owners, bad types, NULL handle,
  station wrapped twice, API-role write privileges). Fix the data deliberately, then re-run.
  `lock_timeout` (55P03) means traffic held a lock; retry in a quiet moment.
- **Applied but must be reverted:** `docs/rollback/021_down_innhouse_canonical_reconciliation.sql`
  (single transaction). It restores the exact production shape and aborts, changing nothing,
  if data already depends on the canonical rules (more than one creator per House, a handle used
  in two Houses, `station` Houses, `radio` channels). In that case fix forward instead.
- **Data problem after go-live:** restore the recorded PITR point only as a last resort; prefer a forward fix.
- The runner baseline is just rows in `public.schema_migrations`; remove a mistaken row with a single `DELETE` and nothing else changes.

## 6. Owner bootstrap (prepared, **not executed**)

What the code actually does:
- `POST /api/auth/register` creates a user with the platform role **LISTENER** only, with a password the person chooses.
- Platform roles are granted by `POST /api/admin/users/:id/roles/:role`, which needs the `users.manage` permission, held only by SUPER_ADMIN. **There is no API path to the very first SUPER_ADMIN**: the 017 seed grants House ownership to the earliest SUPER_ADMIN/ADMIN only if one existed at migration time, and production has zero users.
- `POST /api/houses/:house/ownership/bootstrap` is self-only, requires platform SUPER_ADMIN, and works only while the House has zero active owners; it serialises with an advisory lock.

Procedure (to be run by the owner, only after 021 is applied and verified, and only with explicit go-ahead):
1. The owner registers through the real UI/endpoint with their own password (no one else sees it).
2. One out-of-band, owner-run SQL statement grants the first platform role. It bypasses the audit entry that the admin route would write, so add an `audit_events` row by hand if you want it recorded:
   ```sql
   insert into user_roles (user_id, role_id)
   select u.id, r.id from users u, roles r where u.email = '<owner email>' and r.name = 'SUPER_ADMIN';
   ```
3. The owner logs in and calls `POST /api/houses/nyce-fm/ownership/bootstrap` (no body). Expect `201 {houseId, ownerId}`; a second call returns `409 HOUSE_ALREADY_HAS_OWNER`.
4. Verify: exactly one row `role='owner' status='active'` for `nyce-fm`; consider then removing SUPER_ADMIN from the account if day-to-day use does not need it.
No user, role grant or House ownership change was made in production, and no authentication was bypassed.

## 7. Remaining blockers and open items

| # | Item | Needed from |
|---|---|---|
| 1 | Review of this plan and the security notes, then **explicit authorization** to run on production | owner |
| 2 | CI must run both suites (Postgres + Redis service for `npm test`; `psql` + Postgres for `npm run test:migration`); no workflow file exists yet in the repo for either | engineering |
| 3 | Optional pre-prod rehearsal on a Supabase branch (real roles, PG 17); may be a paid feature | owner |
| 4 | Security review of items found, not changed: public-read policies if grants are ever added; undocumented revoke of `authenticated` on `is_station_house_*`; policies referencing non-executable helpers | owner / security review |
| 5 | Out-of-repo production drift captured but not owned elsewhere: two indexes (now in 021), and the function-ACL revoke above | owner |
| 6 | First SUPER_ADMIN has no API path (section 6) | owner |
| 7 | Not yet verified end to end: login, owner permissions, broadcasting, background workers, Stripe/AI paths (this phase covered the INNHOUSE schema only) | smoke test after deploy |
| 8 | Vitest 2 dev-chain advisories remain (6, dev-only; fix needs a breaking upgrade) | engineering |
| 9 | Environments other than production seeded from the old `nycefm` slug, if any | owner |
