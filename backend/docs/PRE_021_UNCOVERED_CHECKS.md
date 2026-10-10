# Pre-021 checks NOT covered by the fingerprint gate

The fingerprint covers public-schema structure and ACLs only. Each item below must be closed and
recorded separately before migration 021 is authorized. Status is deliberately OPEN until evidence is attached.

| # | Area | What must be established | Status | Evidence |
|---|---|---|---|---|
| 1 | Supabase Auth configuration | JWT settings, redirect URLs, email/provider settings match what the deployed API assumes | OPEN | |
| 2 | Storage policies | Bucket policies for the private media bucket match the intended access model | OPEN | |
| 3 | Deployed environment variables | Required vars present and correct on the deployment (no values recorded here) | OPEN | |
| 4 | Row-data assumptions | Existing production rows satisfy the constraints/rules 021 introduces (e.g. single active owner, canonical references); verified with read-only queries on production | OPEN | |
| 5 | Real-Supabase RLS behavior | RLS that depends on `auth.uid()`/JWT claims is tested against real Supabase Auth; local tests use a platform stub | OPEN | |
| 6 | Verifier-role rehearsal on a Supabase host | `verify-prod-fingerprint.sh` run once through the real connection path (direct vs pooler) | OPEN | |
