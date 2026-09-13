import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "../..");

dotenv.config({ path: path.join(BACKEND_ROOT, ".env.test"), override: true });

// Imported after dotenv.config so NODE_ENV=test is already set when the
// guard's assertTestEnv() runs.
const { getTestDatabaseUrl, getTestRedisUrl } = await import("./env.js");

// The app's own modules (src/db/pool.ts, src/lib/redis.ts) read
// DATABASE_URL / REDIS_URL directly and are singletons created at import
// time. We funnel through the guarded TEST_DATABASE_URL / TEST_REDIS_URL
// getters here, then assign into the names the app actually reads, so
// every test in this worker is guaranteed to be running against a
// validated, non-production instance before any app code is imported.
process.env.DATABASE_URL = getTestDatabaseUrl();
process.env.REDIS_URL = getTestRedisUrl();
