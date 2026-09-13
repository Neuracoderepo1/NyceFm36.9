import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

// Runs once, in its own process, before any test file. Deliberately does
// NOT import anything from src/ - this must stay independent of the app's
// own DATABASE_URL-reading pool singleton, so we never risk this step
// silently reusing a production connection cached from another import path.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "../..");
const MIGRATIONS_DIR = path.join(BACKEND_ROOT, "src/db/migrations");
const STUB_FILE = path.join(__dirname, "supabase-platform-stub.sql");
const KNOWN_PRODUCTION_PROJECT_REF = "qmrqkmddkveoinvspqvn";

export default async function globalSetup() {
  dotenv.config({ path: path.join(BACKEND_ROOT, ".env.test"), override: true });

  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set (check backend/.env.test).");
  }

  const host = new URL(url).hostname.toLowerCase();
  if (host.includes(KNOWN_PRODUCTION_PROJECT_REF)) {
    throw new Error("Refusing to migrate: TEST_DATABASE_URL matches the known production project ref.");
  }
  const looksLikeSupabase = host.endsWith("supabase.co") || host.endsWith("supabase.com");
  if (looksLikeSupabase && process.env.ALLOW_SUPABASE_TEST_DB !== "true") {
    throw new Error(
      "Refusing to migrate: TEST_DATABASE_URL looks like a Supabase host. " +
        "Set ALLOW_SUPABASE_TEST_DB=true only if this is a genuine disposable branch."
    );
  }

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    // 1. Stub the minimum Supabase platform schema our migrations touch,
    //    so real, unmodified production migrations can apply here.
    await pool.query(readFileSync(STUB_FILE, "utf8"));

    // 2. Apply real production migrations, same logic as src/db/migrate.ts.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await pool.query("SELECT filename FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.filename as string));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[global-setup] migration failed: ${file}`);
        throw err;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}
