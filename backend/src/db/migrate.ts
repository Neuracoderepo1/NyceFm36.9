import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

// --baseline-through <filename>  (or --baseline-through=<filename>)
// Records every repo migration file up to AND INCLUDING <filename> as already applied
// without executing it. A bare --baseline is refused on purpose: baselining "everything"
// would also mark not-yet-applied migrations (e.g. 021) as done and silently skip them.
function baselineThrough(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--baseline") {
      throw new Error("--baseline requires an explicit cut-off: use --baseline-through <filename>");
    }
    if (args[i] === "--baseline-through") {
      const v = args[i + 1];
      if (!v || v.startsWith("--")) throw new Error("--baseline-through requires a migration filename");
      return v;
    }
    if (args[i].startsWith("--baseline-through=")) return args[i].slice("--baseline-through=".length);
  }
  return null;
}

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
      "backend/docs/MIGRATION_RECONCILIATION.md, then run `npm run migrate -- --baseline-through <last file " +
      "already applied in production>` once to record those repo files as applied (no SQL is executed)."
  );
}

async function baseline(through: string) {
  const files = migrationFiles();
  if (!files.includes(through)) {
    throw new Error(`--baseline-through: no such migration file: ${through}`);
  }
  const upTo = files.filter((f) => f <= through);
  const pending = files.filter((f) => f > through);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  for (const file of upTo) {
    await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING", [file]);
  }
  console.log(`baselined ${upTo.length} migration file(s) through ${through} (no SQL executed)`);
  console.log(`still pending: ${pending.length ? pending.join(", ") : "(none)"}`);
  await pool.end();
}

async function run() {
  const through = baselineThrough();
  if (through) return baseline(through);

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
