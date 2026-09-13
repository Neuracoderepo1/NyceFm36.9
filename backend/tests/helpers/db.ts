import pg from "pg";
import { getTestDatabaseUrl } from "./env.js";

// A separate pool from the app's own src/db/pool.ts singleton. Tests use
// this one directly for setup/teardown/assertions against raw rows, while
// the app-under-test (created via tests/helpers/app.ts) uses its own pool
// pointed at the same DATABASE_URL by tests/helpers/setup.ts.
export const testPool = new pg.Pool({ connectionString: getTestDatabaseUrl(), max: 5 });

// Tables seeded by migrations that must survive a reset (the default
// station + its settings row). Everything else in `public` is
// test-generated and safe to wipe between tests for isolation.
const SEED_TABLES = new Set(["stations", "station_settings", "schema_migrations"]);

let cachedResettableTables: string[] | null = null;

async function resettableTables(): Promise<string[]> {
  if (cachedResettableTables) return cachedResettableTables;
  const { rows } = await testPool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  cachedResettableTables = rows
    .map((r) => r.tablename)
    .filter((name) => !SEED_TABLES.has(name));
  return cachedResettableTables;
}

/**
 * Truncates all test-generated data between tests while preserving the
 * seeded default station. Call from an `afterEach` (or `beforeEach`) in any
 * integration test that touches the database.
 */
export async function resetDatabase(): Promise<void> {
  const tables = await resettableTables();
  if (tables.length === 0) return;
  const identifiers = tables.map((t) => `"public"."${t}"`).join(", ");
  await testPool.query(`TRUNCATE TABLE ${identifiers} RESTART IDENTITY CASCADE`);
}

export async function getDefaultStationRow(): Promise<{ id: string; slug: string; name: string }> {
  const { rows } = await testPool.query(`SELECT id, slug, name FROM stations WHERE slug = 'nyce-fm'`);
  if (!rows[0]) throw new Error("Default seeded station not found - did global setup run migrations?");
  return rows[0];
}

export async function closeTestPool(): Promise<void> {
  await testPool.end();
}
