import { defineConfig } from "vitest/config";

// Production-rehearsal suite: builds an isolated Postgres database that reproduces
// production's schema and exercises migration 021 against it. Needs a LOCAL Postgres
// (psql on PATH). Run with:  npm run test:migration
export default defineConfig({
  test: {
    include: ["tests/migration/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 180000,
    fileParallelism: false,
  },
});
