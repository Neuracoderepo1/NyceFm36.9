# Production fingerprint gate (pre-migration 021)

**Rule:** migration 021 is not applied until this gate has been run against production, every
difference has been reviewed, and any drift has been reconciled. Production stays unchanged until then.

## What a pass means (and does not)
A pass (exit 0) means the checked **public-schema structure and ACLs** match the committed baseline
`tests/migration/production-fingerprint.json`. It does **not** prove the whole production system is safe
to migrate. Uncovered checks are tracked in `PRE_021_UNCOVERED_CHECKS.md` and must be closed separately.

## Exit codes (the deployment process fails closed)
| Exit | Meaning | Action |
|---|---|---|
| 0 | All 7 categories match | Gate satisfied. Continue to the uncovered checks. |
| 1 | At least one category differs | **Stop.** Review every mismatch; reconcile; re-run. |
| 2 | Could not run safely (no connection, session not read-only, missing files) | **Stop.** This is an abort, never a pass. |

Anything other than 0, including a script that did not run, blocks 021.

## Steps
1. **Re-capture the `columns` baseline live (one time).** The columns query moved from `information_schema`
   to `pg_attribute` so a zero-privilege role can run it. The new hash was computed on the isolated snapshot
   (which reproduced all prior live hashes) but has not been captured from production. Using an existing
   privileged role in a read-only session, run `tests/migration/fingerprint.sql` and confirm `columns` is
   `314 | 3333d9bc48e6db78e871f2de918c845a`. If it differs, treat as drift: stop and reconcile before changing
   the baseline. Then delete the PROVENANCE sentence from `_comment` in the baseline file.
2. **Create the verifier role** by running `docs/verifier-role.sql` as the owner (set the password in the SQL
   editor; never commit it). Connect, USAGE only: no row data, no table privileges. Granting table privileges
   would also change table ACLs and falsify the ACL category. Assumes the database is named `postgres`.
3. **Run the gate** from `backend/` with the verifier's connection string in the environment:
   `PROD_READONLY_URL='postgresql://fp_verifier:...' bash verify-prod-fingerprint.sh`
   Prefer a direct connection. The script sets `default_transaction_read_only` via connection options, and a
   pooler may reject startup options; if so the script exits 2 (fail closed) rather than passing.
4. **Review every mismatch** category by category before anyone authorizes 021. Record the outcome
   (date, exit code, reviewer) in the migration ticket.
5. **Revoke the role** when the window closes: `DROP OWNED BY fp_verifier; DROP ROLE fp_verifier;`

## Controls, ranked
1. Database permissions on `fp_verifier` (no table privileges, cannot read rows).
2. `ALTER ROLE ... SET default_transaction_read_only = on` plus the script's read-only session check.
   These are defense in depth, not a substitute for (1).

## Tested locally (not against production)
Match, drift, unreachable and write-blocked cases; and the gate through a zero-privilege role on the isolated
production snapshot. Not tested against a Supabase host or pooler.
