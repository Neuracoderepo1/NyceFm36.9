import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

const BASELINE = process.argv.includes("--baseline");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Safety guard for databases that were migrated through Supabase's own
 * migration history (supabase_migrations.schema_migrations) rather than this
 * runner. On such a database public.schema_migrations is missing or empty, so
 * a plain run would replay every file -- including repo migrations (notably
 * 017) whose definitions differ from what actually ran in production. Refuse
 * unless the operator has explicitly baselined it.
 * See docs/MIGRATION_RECONCILIATION.md.
 */
async function assertNotUnbaselinedSupabaseDb(): Promise<void> {
  const { rows } = await pool.query(`
    SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS has_supabase_history,
           to_regclass('public.schema_migrations') IS NOT NULL AS has_tracker
  `);
  const { has_supabase_history, has_tracker } = rows[0] as { has_supabase_history: boolean; has_tracker: boolean };
  if (!has_supabase_history) return;

  let trackerRows = 0;
  if (has_tracker) {
    const r = await pool.query("SELECT count(*)::int AS n FROM public.schema_migrations");
    trackerRows = r.rows[0].n;
  }
  if (trackerRows > 0) return;

  throw new Error(
    "Refusing to migrate: this database has Supabase migration history but public.schema_migrations " +
      "is missing or empty, so every repo migration would be replayed. Review " +
      "backend/docs/MIGRATION_RECONCILIATION.md, then run `npm run migrate -- --baseline` once to record " +
      "the current repo files as already applied (no SQL is executed)."
  );
}

async function baseline() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const files = migrationFiles();
  for (const file of files) {
    await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING", [file]);
  }
  console.log(`baselined ${files.length} migration file(s) as applied (no SQL executed)`);
  await pool.end();
}

async function run() {
  if (BASELINE) return baseline();

  await assertNotUnbaselinedSupabaseDb();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = migrationFiles();

  const { rows } = await pool.query("SELECT filename FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`apply ${file} ... OK`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`apply ${file} ... FAILED`);
      throw err;
    } finally {
      client.release();
    }
  }
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
