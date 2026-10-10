import type { Pool } from "pg";

/**
 * Startup diagnostic: reports which database role the running API is really
 * connected as, whether that role bypasses Row Level Security, and what it can
 * do to the tables the INNHOUSE / auth paths depend on.
 *
 * Purpose: production policies are written for API roles, but the backend
 * connects with a single DATABASE_URL. Whether RLS is actually enforced for
 * that connection depends on the role's rolsuper / rolbypassrls flags, and
 * that must be observed on the deployed connection, not assumed.
 *
 * Safety: this reads only pg_catalog metadata about the CURRENT role. It never
 * reads row data, never logs DATABASE_URL, a password, a host or any other
 * credential material, and a failure here is logged but never blocks startup.
 */

export const DIAGNOSTIC_TABLES = [
  "houses",
  "creators",
  "house_members",
  "channels",
  "stations",
  "users",
  "user_roles",
  "roles",
  "audit_events",
  "schema_migrations",
] as const;

export interface TablePrivilegeReport {
  table: string;
  present: boolean;
  rls_enabled: boolean | null;
  rls_forced: boolean | null;
  select: boolean | null;
  insert: boolean | null;
  update: boolean | null;
  delete: boolean | null;
}

export interface DbRoleDiagnostic {
  effective_role: string;
  session_role: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  /** True only when neither flag lets the connection skip RLS. */
  rls_enforced_for_connection: boolean;
  database: string;
  server_version: string;
  tables: TablePrivilegeReport[];
}

export async function collectDbRoleDiagnostic(pool: Pick<Pool, "query">): Promise<DbRoleDiagnostic> {
  const role = await pool.query<{
    effective_role: string;
    session_role: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    database: string;
    server_version: string;
  }>(
    `SELECT current_user::text AS effective_role,
            session_user::text AS session_role,
            r.rolsuper,
            r.rolbypassrls,
            current_database()::text AS database,
            current_setting('server_version') AS server_version
       FROM pg_roles r
      WHERE r.rolname = current_user`
  );
  const row = role.rows[0];
  if (!row) throw new Error("current role not found in pg_roles");

  const tables = await pool.query<TablePrivilegeReport>(
    `SELECT t.name AS "table",
            c.oid IS NOT NULL AS present,
            c.relrowsecurity AS rls_enabled,
            c.relforcerowsecurity AS rls_forced,
            CASE WHEN c.oid IS NULL THEN NULL ELSE has_table_privilege(current_user, c.oid, 'SELECT') END AS "select",
            CASE WHEN c.oid IS NULL THEN NULL ELSE has_table_privilege(current_user, c.oid, 'INSERT') END AS "insert",
            CASE WHEN c.oid IS NULL THEN NULL ELSE has_table_privilege(current_user, c.oid, 'UPDATE') END AS "update",
            CASE WHEN c.oid IS NULL THEN NULL ELSE has_table_privilege(current_user, c.oid, 'DELETE') END AS "delete"
       FROM unnest($1::text[]) WITH ORDINALITY AS t(name, ord)
       LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || quote_ident(t.name))
      ORDER BY t.ord`,
    [DIAGNOSTIC_TABLES as unknown as string[]]
  );

  return {
    ...row,
    rls_enforced_for_connection: !row.rolsuper && !row.rolbypassrls,
    tables: tables.rows,
  };
}

/**
 * Logs one JSON line tagged `[startup:db-role]`. Never throws.
 */
export async function logDbRoleDiagnostic(pool: Pick<Pool, "query">): Promise<DbRoleDiagnostic | null> {
  try {
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error("db-role diagnostic timed out after 5s")), 5000);
      t.unref();
    });
    const report = await Promise.race([collectDbRoleDiagnostic(pool), timeout]);
    console.log(`[startup:db-role] ${JSON.stringify(report)}`);
    if (!report.rls_enforced_for_connection) {
      console.warn(
        `[startup:db-role] WARNING role "${report.effective_role}" bypasses RLS ` +
          `(rolsuper=${report.rolsuper}, rolbypassrls=${report.rolbypassrls}); ` +
          `authorization for this connection rests entirely on application code.`
      );
    }
    return report;
  } catch (err) {
    // Message only: pg errors can embed connection details in other fields.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[startup:db-role] diagnostic failed -- ${message}`);
    return null;
  }
}
