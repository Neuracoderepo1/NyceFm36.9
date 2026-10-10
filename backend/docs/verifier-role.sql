-- Dedicated, minimum-privilege role for the production fingerprint gate.
-- Run ONCE by the database owner (Supabase SQL editor) -- this is a deliberate, reviewed change,
-- not part of the gate itself. Set the password in the editor; never commit it.
--
-- Grants: connect + schema USAGE only. NO table, sequence or function privileges, so the role
-- cannot read any row data. The fingerprint reads only pg_catalog, which every role can read.
-- Granting table privileges would also alter table ACLs and falsify the table_acl_innhouse category.

CREATE ROLE fp_verifier LOGIN PASSWORD '<set-in-editor-not-in-git>' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE postgres TO fp_verifier;
GRANT USAGE ON SCHEMA public TO fp_verifier;
ALTER ROLE fp_verifier SET default_transaction_read_only = on;   -- defense in depth, not the control
ALTER ROLE fp_verifier SET statement_timeout = '30s';
ALTER ROLE fp_verifier CONNECTION LIMIT 2;

-- Revoke when the migration window closes:
--   DROP OWNED BY fp_verifier; DROP ROLE fp_verifier;
