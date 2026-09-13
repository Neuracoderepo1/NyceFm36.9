/**
 * Test-environment guard.
 *
 * Every integration/security test that touches a real database or Redis
 * instance must go through `getTestDatabaseUrl()` / `getTestRedisUrl()`
 * below rather than reading `process.env.DATABASE_URL` / `REDIS_URL`
 * directly. This is the single choke point that prevents a misconfigured
 * test run from mutating (or worse, migrating/truncating) production data.
 *
 * Safety rules enforced here:
 *  - `NODE_ENV` must be `test` for any of this to proceed.
 *  - `TEST_DATABASE_URL` (not `DATABASE_URL`) is the only source of the
 *    test database connection string.
 *  - If that URL's host looks like a Supabase-managed host (contains
 *    "supabase.co" or "supabase.com" - i.e. direct connections, the
 *    session/transaction pooler, or any project subdomain) the run is
 *    refused unless `ALLOW_SUPABASE_TEST_DB=true` is explicitly set. This
 *    catches the most common accident: copy-pasting the production
 *    DATABASE_URL into TEST_DATABASE_URL.
 *  - Even with that override set, if the host matches this repo's known
 *    production project ref, the run is refused unconditionally - there is
 *    no override for that, on purpose.
 */

const KNOWN_PRODUCTION_PROJECT_REF = "qmrqkmddkveoinvspqvn";

function assertTestEnv(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Refusing to build a test DB/Redis connection outside NODE_ENV=test. " +
        `Current NODE_ENV=${String(process.env.NODE_ENV)}.`
    );
  }
}

function assertNotProductionHost(rawUrl: string, label: string): void {
  let host = "";
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    // Not a parseable URL - let the caller's own connection attempt fail
    // with a clearer driver-level error instead of masking it here.
    return;
  }

  if (host.includes(KNOWN_PRODUCTION_PROJECT_REF)) {
    throw new Error(
      `Refusing to run tests against ${label}: host "${host}" matches this ` +
        "repo's known production Supabase project ref. There is no override " +
        "for this check - point TEST_DATABASE_URL/TEST_REDIS_URL at a " +
        "disposable local/CI instance instead."
    );
  }

  const looksLikeSupabase = host.endsWith("supabase.co") || host.endsWith("supabase.com");
  if (looksLikeSupabase && process.env.ALLOW_SUPABASE_TEST_DB !== "true") {
    throw new Error(
      `Refusing to run tests against ${label}: host "${host}" looks like a ` +
        "Supabase-managed host. If this is genuinely a disposable Supabase " +
        "branch (not the production project), set ALLOW_SUPABASE_TEST_DB=true " +
        "explicitly to proceed."
    );
  }
}

export function getTestDatabaseUrl(): string {
  assertTestEnv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests require a disposable " +
        "Postgres instance - do NOT fall back to DATABASE_URL."
    );
  }
  assertNotProductionHost(url, "TEST_DATABASE_URL");
  return url;
}

export function getTestRedisUrl(): string {
  assertTestEnv();
  const url = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1";
  assertNotProductionHost(url, "TEST_REDIS_URL");
  return url;
}

/** Fields that must never be printed to test output, logs, or error messages. */
export const NEVER_LOG_ENV_KEYS = [
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "REDIS_URL",
  "TEST_REDIS_URL",
  "SESSION_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "ANTHROPIC_API_KEY",
] as const;
