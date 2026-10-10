import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// Production-rehearsal suite for migration 021_innhouse_canonical_reconciliation.sql.
//
// Everything runs against a LOCAL, disposable Postgres. The base database is built by
// build-prod-snapshot.sh (platform stub + repo migrations 001-016 + the live INNHOUSE
// migrations 017-020) and must reproduce the fingerprint captured read-only from the
// real production database before any assertion about the migration is meaningful.
// Production is never contacted from this file.

const HERE = import.meta.dirname;
const BACKEND = path.resolve(HERE, "../..");
const MIGRATIONS_DIR = path.join(BACKEND, "src/db/migrations");
const PGHOST = process.env.MIGRATION_TEST_PGHOST ?? "localhost";
const PGUSER = process.env.MIGRATION_TEST_PGUSER ?? "postgres";
const PGPASSWORD = process.env.MIGRATION_TEST_PGPASSWORD ?? "postgres";

if (!/^(localhost|127\.0\.0\.1)$/.test(PGHOST)) {
  throw new Error("Refusing to run: migration tests only run against a local, disposable Postgres.");
}

const BASE = "nycefm_mig_base";
const FRESH = "nycefm_mig_fresh";
const url = (db: string) => `postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:5432/${db}`;
const admin = new pg.Pool({ connectionString: url("postgres"), max: 2 });

const MIGRATION_021 = fs.readFileSync(path.join(MIGRATIONS_DIR, "021_innhouse_canonical_reconciliation.sql"), "utf8");
const FINGERPRINT_SQL = fs.readFileSync(path.join(HERE, "fingerprint.sql"), "utf8");
const PROD_FINGERPRINT = JSON.parse(fs.readFileSync(path.join(HERE, "production-fingerprint.json"), "utf8"));
delete PROD_FINGERPRINT._comment;

const scratch: string[] = [];
const pools: pg.Pool[] = [];

async function copyDb(name: string): Promise<pg.Pool> {
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${BASE}`);
  scratch.push(name);
  const pool = new pg.Pool({ connectionString: url(name), max: 3 });
  pools.push(pool);
  return pool;
}

async function applySql(pool: pg.Pool, sql: string) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(sql);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
const apply021 = (pool: pg.Pool) => applySql(pool, MIGRATION_021);

type PgErr = { code?: string; constraint?: string; message: string };
async function pgError(p: Promise<unknown>): Promise<PgErr> {
  try {
    await p;
  } catch (e) {
    return e as PgErr;
  }
  throw new Error("expected a Postgres error but the statement succeeded");
}

async function fingerprint(pool: pg.Pool): Promise<Record<string, { n: number; h: string }>> {
  const { rows } = await pool.query(FINGERPRINT_SQL);
  return Object.fromEntries(rows.map((r) => [r.cat, { n: Number(r.n), h: r.h }]));
}

async function dataState(pool: pg.Pool) {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM houses) AS houses,
      (SELECT count(*)::int FROM creators) AS creators,
      (SELECT count(*)::int FROM channels) AS channels,
      (SELECT count(*)::int FROM house_members) AS members,
      (SELECT count(*)::int FROM users) AS users,
      (SELECT md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY id), '')) FROM houses t) AS houses_h,
      (SELECT md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY id), '')) FROM creators t) AS creators_h,
      (SELECT md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY id), '')) FROM channels t) AS channels_h,
      (SELECT md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY id), '')) FROM stations t) AS stations_h,
      (SELECT md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY house_id, user_id), '')) FROM house_members t) AS members_h
  `);
  return rows[0];
}

async function constraintsOf(pool: pg.Pool): Promise<Record<string, string>> {
  const { rows } = await pool.query(`
    SELECT cl.relname || '.' || co.conname AS k, pg_get_constraintdef(co.oid) AS def
      FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid
     WHERE cl.relnamespace = 'public'::regnamespace AND cl.relname IN ('houses','creators','house_members','channels')`);
  const norm = (d: string) =>
    d.replace(/ARRAY\[([^\]]*)\]/g, (_m, inner: string) => `ARRAY[${inner.split(",").map((x) => x.trim()).sort().join(", ")}]`);
  return Object.fromEntries(rows.map((r) => [r.k, norm(r.def)]));
}

async function inTxn<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

async function mkUser(pool: pg.Pool | pg.PoolClient, label: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x',$2) RETURNING id`,
    [`${label}-${Math.random().toString(36).slice(2, 8)}@example.test`, label]
  );
  return rows[0].id;
}

beforeAll(async () => {
  execFileSync(path.join(HERE, "build-prod-snapshot.sh"), [BASE], {
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD },
    stdio: "pipe",
  });
});

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
  for (const db of [...scratch, FRESH]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
});

// ---------------------------------------------------------------------------
describe("isolated snapshot fidelity", () => {
  it("reproduces the live production catalog fingerprint exactly (all 7 categories)", async () => {
    const pool = await copyDb("nycefm_mig_fidelity");
    const fp = await fingerprint(pool);
    for (const cat of Object.keys(PROD_FINGERPRINT)) {
      expect(fp[cat], cat).toEqual(PROD_FINGERPRINT[cat]);
    }
  });

  it("has the production data shape: one House 'nyce-fm', one creator, one channel, no users or members", async () => {
    const pool = await copyDb("nycefm_mig_shape");
    const d = await dataState(pool);
    expect(d).toMatchObject({ houses: 1, creators: 1, channels: 1, members: 0, users: 0 });
    const { rows } = await pool.query(
      `SELECT h.slug, h.house_type, c.channel_type, cr.handle,
              (SELECT s.slug FROM stations s WHERE s.id = c.legacy_station_id) AS station_slug
         FROM houses h JOIN channels c ON c.house_id = h.id JOIN creators cr ON cr.house_id = h.id`
    );
    expect(rows).toEqual([{ slug: "nyce-fm", house_type: "creator", channel_type: "broadcast", handle: "nyce-fm", station_slug: "nyce-fm" }]);
  });

  it("documents the live (non-canonical) behaviour that 021 exists to fix", async () => {
    const pool = await copyDb("nycefm_mig_prefix");
    const { rows } = await pool.query(`SELECT id FROM houses LIMIT 1`);
    const houseId = rows[0].id;
    // One creator per House in production today:
    expect((await pgError(pool.query(`INSERT INTO creators (house_id, handle, display_name) VALUES ($1,'second','Second')`, [houseId]))).constraint).toBe("creators_house_id_key");
    // 'station' is not an allowed House type, 'editor' is an allowed role (five roles):
    expect((await pgError(pool.query(`INSERT INTO houses (slug, name, house_type) VALUES ('s','S','station')`))).constraint).toBe("houses_house_type_check");
    const u = await mkUser(pool, "u");
    await pool.query(`INSERT INTO house_members (house_id, user_id, role) VALUES ($1,$2,'editor')`, [houseId, u]);
  });
});

// ---------------------------------------------------------------------------
describe("forward migration 021 on the production snapshot", () => {
  let pool: pg.Pool;
  let preFp: Record<string, { n: number; h: string }>;
  let preData: Awaited<ReturnType<typeof dataState>>;
  let postFp: Record<string, { n: number; h: string }>;
  let postData: Awaited<ReturnType<typeof dataState>>;

  beforeAll(async () => {
    pool = await copyDb("nycefm_mig_main");
    preFp = await fingerprint(pool);
    preData = await dataState(pool);
    await apply021(pool);
    postFp = await fingerprint(pool);
    postData = await dataState(pool);
  });

  it("changes no data: row hashes, counts and the 'nyce-fm' slug are untouched; no second House appears", async () => {
    expect(postData).toEqual(preData);
    const { rows } = await pool.query(`SELECT slug FROM houses ORDER BY slug`);
    expect(rows.map((r) => r.slug)).toEqual(["nyce-fm"]);
  });

  it("does not touch policies, functions, RLS state, or table ACLs", async () => {
    for (const cat of ["policies", "functions", "rls", "table_acl_innhouse"]) {
      expect(postFp[cat], cat).toEqual(preFp[cat]);
    }
  });

  it("changes only constraints/indexes and two column defaults", async () => {
    expect(postFp.constraints.h).not.toBe(preFp.constraints.h);
    // Two unique indexes dropped (creators_house_id_key, creators_handle_key); two added
    // (creators_house_id_handle_key, uq_house_members_one_active_owner) => net zero.
    expect(postFp.indexes.n).toBe(preFp.indexes.n);
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public'
        AND indexname IN ('creators_house_id_key','creators_handle_key','creators_house_id_handle_key','uq_house_members_one_active_owner')
        ORDER BY indexname`
    );
    expect(rows.map((r) => r.indexname)).toEqual(["creators_house_id_handle_key", "uq_house_members_one_active_owner"]);
    const defaults = await pool.query(
      `SELECT table_name||'.'||column_name AS c, column_default AS d FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('houses','channels') AND column_name IN ('house_type','channel_type') ORDER BY 1`
    );
    expect(defaults.rows).toEqual([
      { c: "channels.channel_type", d: "'radio'::text" },
      { c: "houses.house_type", d: "'station'::text" },
    ]);
  });

  it("is a no-op in effect when run a second time", async () => {
    await apply021(pool);
    expect(await fingerprint(pool)).toEqual(postFp);
    expect(await dataState(pool)).toEqual(postData);
  });

  it("supports multiple creators per House with per-House handle uniqueness", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const { rows } = await c.query(`SELECT id FROM houses WHERE slug='nyce-fm'`);
      const h1 = rows[0].id;
      const h2 = (await c.query(`INSERT INTO houses (slug, name) VALUES ('second','Second') RETURNING id`)).rows[0].id;
      await c.query(`INSERT INTO creators (house_id, handle, display_name) VALUES ($1,'alpha','A'),($1,'bravo','B'),($2,'alpha','A2')`, [h1, h2]);
      await c.query("SAVEPOINT s");
      const err = await pgError(c.query(`INSERT INTO creators (house_id, handle, display_name) VALUES ($1,'alpha','dup')`, [h1]));
      expect(err.constraint).toBe("creators_house_id_handle_key");
      await c.query("ROLLBACK TO s");
      const n = await c.query(`SELECT count(*)::int AS n FROM creators WHERE house_id=$1`, [h1]);
      expect(n.rows[0].n).toBe(3); // original founding creator + alpha + bravo
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("accepts the three canonical roles and rejects editor/moderator", async () => {
    await inTxn(pool, async (c) => {
      const h = (await c.query(`SELECT id FROM houses LIMIT 1`)).rows[0].id;
      const users = [await mkUser(c, "a"), await mkUser(c, "b"), await mkUser(c, "c"), await mkUser(c, "d"), await mkUser(c, "e")];
      await c.query(`INSERT INTO house_members (house_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member')`, [h, users[0], users[1], users[2]]);
      for (const [i, role] of [[3, "editor"], [4, "moderator"]] as const) {
        await c.query("SAVEPOINT s");
        expect((await pgError(c.query(`INSERT INTO house_members (house_id,user_id,role) VALUES ($1,$2,$3)`, [h, users[i], role]))).constraint).toBe("house_members_role_check");
        await c.query("ROLLBACK TO s");
      }
    });
  });

  it("accepts every canonical House/channel type and rejects others", async () => {
    await inTxn(pool, async (c) => {
      let i = 0;
      for (const t of ["station", "creator", "brand", "community", "organization"]) {
        await c.query(`INSERT INTO houses (slug, name, house_type) VALUES ($1,'H',$2)`, [`t-${i++}`, t]);
      }
      const h = (await c.query(`SELECT id FROM houses LIMIT 1`)).rows[0].id;
      for (const t of ["radio", "broadcast", "content", "community", "live", "other"]) {
        await c.query(`INSERT INTO channels (house_id, slug, name, channel_type) VALUES ($1,$2,'C',$3)`, [h, `c-${t}`, t]);
      }
      await c.query("SAVEPOINT s");
      expect((await pgError(c.query(`INSERT INTO houses (slug, name, house_type) VALUES ('bad','H','spaceship')`))).constraint).toBe("houses_house_type_check");
      await c.query("ROLLBACK TO s");
    });
  });

  it("enforces one active owner and supports a transfer (demote first, then promote)", async () => {
    await inTxn(pool, async (c) => {
      const h = (await c.query(`SELECT id FROM houses LIMIT 1`)).rows[0].id;
      const [a, b] = [await mkUser(c, "a"), await mkUser(c, "b")];
      await c.query(`INSERT INTO house_members (house_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')`, [h, a, b]);
      await c.query("SAVEPOINT s");
      expect((await pgError(c.query(`UPDATE house_members SET role='owner' WHERE house_id=$1 AND user_id=$2`, [h, b]))).constraint).toBe("uq_house_members_one_active_owner");
      await c.query("ROLLBACK TO s");
      await c.query(`UPDATE house_members SET role='admin' WHERE house_id=$1 AND user_id=$2`, [h, a]);
      await c.query(`UPDATE house_members SET role='owner' WHERE house_id=$1 AND user_id=$2`, [h, b]);
      const { rows } = await c.query(`SELECT user_id FROM house_members WHERE house_id=$1 AND role='owner' AND status='active'`, [h]);
      expect(rows).toEqual([{ user_id: b }]);
    });
  });

  it("matches the canonical constraint set of a freshly built database (documented additive extras only)", async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${FRESH} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${FRESH}`);
    const fresh = new pg.Pool({ connectionString: url(FRESH), max: 2 });
    pools.push(fresh);
    await fresh.query(fs.readFileSync(path.join(HERE, "../helpers/supabase-platform-stub.sql"), "utf8"));
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
      await applySql(fresh, fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
    }
    const a = await constraintsOf(fresh);
    const b = await constraintsOf(pool);
    const onlyInB = Object.keys(b).filter((k) => !(k in a));
    const onlyInA = Object.keys(a).filter((k) => !(k in b));
    const differing = Object.keys(a).filter((k) => k in b && a[k] !== b[k]);
    expect(onlyInA).toEqual([]);
    expect(onlyInB).toEqual(["creators.creators_user_id_fkey"]); // live-only nullable creators.user_id
    expect(differing).toEqual([]);

    // The fresh database also seeds the same House slug as production.
    const { rows } = await fresh.query(`SELECT slug FROM houses`);
    expect(rows.map((r) => r.slug)).toEqual(["nyce-fm"]);
  });
});

// ---------------------------------------------------------------------------
describe("security: authorization boundaries, RLS, tenant isolation (post-migration)", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await copyDb("nycefm_mig_sec");
    await apply021(pool);
  });

  async function asRole<T>(role: string, sub: string | null, fn: (c: pg.PoolClient) => Promise<T>, setup?: (c: pg.PoolClient) => Promise<void>) {
    return inTxn(pool, async (c) => {
      if (setup) await setup(c);
      if (sub) await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub]);
      await c.query(`SET LOCAL ROLE ${role}`);
      return fn(c);
    });
  }

  for (const role of ["anon", "authenticated"]) {
    it(`${role} cannot read or write any INNHOUSE table (no table privileges, as in production)`, async () => {
      for (const t of ["houses", "creators", "house_members", "channels"]) {
        const e = await pgError(asRole(role, null, (c) => c.query(`SELECT * FROM public.${t}`)));
        expect(e.code, `${role} SELECT ${t}`).toBe("42501");
      }
      expect((await pgError(asRole(role, null, (c) => c.query(`UPDATE public.houses SET name='x'`)))).code).toBe("42501");
      expect((await pgError(asRole(role, null, (c) => c.query(`DELETE FROM public.house_members`)))).code).toBe("42501");
      expect((await pgError(asRole(role, null, (c) => c.query(`INSERT INTO public.creators (house_id,handle,display_name) SELECT id,'x','x' FROM public.houses`)))).code).toBe("42501");
    });
  }

  it("the policies that exist are tenant-isolating even if a future change granted privileges (grants applied inside a rolled-back transaction)", async () => {
    // Seed two Houses and three users (inside the rolled-back txn), then give the API roles table
    // privileges + helper-function EXECUTE *temporarily* and probe the preserved policies.
    await inTxn(pool, async (c) => {
      const h1 = (await c.query(`SELECT id FROM houses WHERE slug='nyce-fm'`)).rows[0].id;
      const h2 = (await c.query(`INSERT INTO houses (slug, name, house_type) VALUES ('other','Other','brand') RETURNING id`)).rows[0].id;
      const h3 = (await c.query(`INSERT INTO houses (slug, name, house_type, status) VALUES ('hidden','Hidden','brand','suspended') RETURNING id`)).rows[0].id;
      const [admin1, member2, outsider] = [await mkUser(c, "admin1"), await mkUser(c, "member2"), await mkUser(c, "outsider")];
      await c.query(`INSERT INTO house_members (house_id,user_id,role) VALUES ($1,$2,'admin'),($3,$4,'member')`, [h1, admin1, h2, member2]);
      await c.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON houses, creators, house_members, channels TO authenticated, anon`);
      await c.query(`GRANT EXECUTE ON FUNCTION current_app_user_id(), is_house_member(uuid), is_house_admin(uuid) TO authenticated, anon`);

      const as = async <T>(role: string, sub: string | null, fn: () => Promise<T>) => {
        await c.query("SAVEPOINT p");
        try {
          if (sub) await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub]);
          await c.query(`SET LOCAL ROLE ${role}`);
          return await fn();
        } finally {
          // Rolling back to the savepoint also restores the role and the jwt setting
          // (both are transaction-scoped), and works even if fn() aborted the transaction.
          await c.query("ROLLBACK TO p");
        }
      };

      // member of House 2 sees only their own membership row, never House 1's.
      const m = await as("authenticated", member2, () => c.query(`SELECT house_id, user_id FROM house_members`));
      expect(m.rows).toEqual([{ house_id: h2, user_id: member2 }]);
      // an outsider sees no membership rows at all.
      expect((await as("authenticated", outsider, () => c.query(`SELECT 1 FROM house_members`))).rowCount).toBe(0);
      // anon sees no membership rows, and only ACTIVE Houses.
      expect((await as("anon", null, () => c.query(`SELECT 1 FROM house_members`))).rowCount).toBe(0);
      const visible = await as("anon", null, () => c.query(`SELECT slug FROM houses ORDER BY slug`));
      expect(visible.rows.map((r) => r.slug)).toEqual(["nyce-fm", "other"]); // 'hidden' (suspended) is not visible
      // a plain member cannot update their own House; nobody can update another House.
      expect((await as("authenticated", member2, () => c.query(`UPDATE houses SET name='x' WHERE id=$1`, [h2]))).rowCount).toBe(0);
      expect((await as("authenticated", admin1, () => c.query(`UPDATE houses SET name='x' WHERE id=$1`, [h2]))).rowCount).toBe(0);
      expect((await as("authenticated", admin1, () => c.query(`UPDATE houses SET name='ok' WHERE id=$1`, [h1]))).rowCount).toBe(1);
      // an admin can add a creator to their own House, not to another.
      await as("authenticated", admin1, () => c.query(`INSERT INTO creators (house_id,handle,display_name) VALUES ($1,'new','New')`, [h1]));
      const e = await pgError(as("authenticated", admin1, () => c.query(`INSERT INTO creators (house_id,handle,display_name) VALUES ($1,'bad','Bad')`, [h2])));
      expect(e.code).toBe("42501");
      // an admin cannot promote themselves or others to owner in another House.
      expect((await as("authenticated", admin1, () => c.query(`UPDATE house_members SET role='owner' WHERE house_id=$1`, [h2]))).rowCount).toBe(0);
    });
  });

  it("helper functions are not executable by anon/authenticated (production ACLs preserved)", async () => {
    for (const fn of ["is_house_member(gen_random_uuid())", "is_house_admin(gen_random_uuid())", "current_app_user_id()"]) {
      for (const role of ["anon", "authenticated"]) {
        expect((await pgError(asRole(role, null, (c) => c.query(`SELECT public.${fn}`)))).code, `${role} ${fn}`).toBe("42501");
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("failure behaviour and recovery", () => {
  it("pre-flight aborts atomically on conflicting data, then succeeds once an operator fixes it", async () => {
    const pool = await copyDb("nycefm_mig_fail1");
    const houseId = (await pool.query(`SELECT id FROM houses LIMIT 1`)).rows[0].id;
    const [a, b, c] = [await mkUser(pool, "a"), await mkUser(pool, "b"), await mkUser(pool, "c")];
    await pool.query(
      `INSERT INTO house_members (house_id,user_id,role,status) VALUES ($1,$2,'owner','active'),($1,$3,'owner','active'),($1,$4,'editor','active')`,
      [houseId, a, b, c]
    );
    const before = await fingerprint(pool);
    const dataBefore = await dataState(pool);

    const err = await pgError(apply021(pool));
    expect(err.message).toContain("pre-flight failed");
    expect(err.message).toContain("non-canonical role");
    expect(err.message).toContain("more than one active owner");

    // Nothing changed: schema and data identical to before the failed attempt.
    expect(await fingerprint(pool)).toEqual(before);
    expect(await dataState(pool)).toEqual(dataBefore);

    // Operator resolves the conflicts explicitly; migration then applies.
    await pool.query(`UPDATE house_members SET role='admin' WHERE house_id=$1 AND user_id=$2`, [houseId, b]);
    await pool.query(`UPDATE house_members SET role='member' WHERE house_id=$1 AND user_id=$2`, [houseId, c]);
    await apply021(pool);
    expect((await fingerprint(pool)).constraints.h).not.toBe(before.constraints.h);
  });

  it("pre-flight refuses if API roles hold write privileges on INNHOUSE tables", async () => {
    const pool = await copyDb("nycefm_mig_fail2");
    await pool.query(`GRANT INSERT ON public.houses TO authenticated`);
    const before = await fingerprint(pool);
    const err = await pgError(apply021(pool));
    expect(err.message).toContain("authenticated holds write privileges");
    expect(await fingerprint(pool)).toEqual(before);
  });

  it("fails fast on lock contention (lock_timeout) without partial changes, then succeeds after release", async () => {
    const pool = await copyDb("nycefm_mig_fail3");
    const before = await fingerprint(pool);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(`LOCK TABLE public.creators IN ACCESS EXCLUSIVE MODE`);
      const started = Date.now();
      const err = await pgError(apply021(pool));
      expect(err.code).toBe("55P03");
      expect(Date.now() - started).toBeLessThan(15000);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    expect(await fingerprint(pool)).toEqual(before);
    await apply021(pool);
    expect((await fingerprint(pool)).constraints.h).not.toBe(before.constraints.h);
  });
});

// ---------------------------------------------------------------------------
describe("forward-recovery script (021 down)", () => {
  const DOWN = fs.readFileSync(path.join(BACKEND, "docs/rollback/021_down_innhouse_canonical_reconciliation.sql"), "utf8");

  it("restores the exact production catalog fingerprint when no data depends on the canonical rules", async () => {
    const pool = await copyDb("nycefm_mig_down1");
    await apply021(pool);
    await applySql(pool, DOWN);
    const fp = await fingerprint(pool);
    for (const cat of Object.keys(PROD_FINGERPRINT)) expect(fp[cat], cat).toEqual(PROD_FINGERPRINT[cat]);
  });

  it("refuses (and changes nothing) once data uses the canonical model", async () => {
    const pool = await copyDb("nycefm_mig_down2");
    await apply021(pool);
    const houseId = (await pool.query(`SELECT id FROM houses LIMIT 1`)).rows[0].id;
    await pool.query(`INSERT INTO creators (house_id, handle, display_name) VALUES ($1,'second','Second')`, [houseId]);
    const before = await fingerprint(pool);
    const err = await pgError(applySql(pool, DOWN));
    expect(err.message).toContain("021 down aborted");
    expect(await fingerprint(pool)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
describe("deployment rehearsal with the real migration runner (npm run migrate)", () => {
  const run = (db: string, ...args: string[]) =>
    spawnSync("npx", ["tsx", "src/db/migrate.ts", ...args], {
      cwd: BACKEND,
      env: { ...process.env, DATABASE_URL: url(db) },
      encoding: "utf8",
      timeout: 120000,
    });

  it("refuses to replay, refuses a bare --baseline, baselines through 017, then applies only 021", async () => {
    const pool = await copyDb("nycefm_mig_runner");
    // Mimic Supabase's own migration history table that production has.
    await pool.query(`CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations (version text primary key, name text)`);
    await pool.query(`INSERT INTO supabase_migrations.schema_migrations VALUES ('20260914174612','017_innhouse_foundation')`);
    const dataBefore = await dataState(pool);

    const plain = run("nycefm_mig_runner");
    expect(plain.status).not.toBe(0);
    expect(plain.stderr).toContain("Refusing to migrate");

    const bare = run("nycefm_mig_runner", "--baseline");
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toContain("--baseline-through");

    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const through = "017_innhouse_foundation_schema.sql";
    const base = run("nycefm_mig_runner", "--baseline-through", through);
    expect(base.status, base.stderr).toBe(0);
    expect(base.stdout).toContain("021_innhouse_canonical_reconciliation.sql");
    const recorded = await pool.query(`SELECT filename FROM public.schema_migrations`);
    // Compare as sets sorted in JS: SQL ORDER BY follows the DB collation, which differs by environment.
    expect(recorded.rows.map((r) => r.filename).sort()).toEqual(files.filter((f) => f <= through));

    const applied = run("nycefm_mig_runner");
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain("apply 021_innhouse_canonical_reconciliation.sql ... OK");
    expect(applied.stdout).not.toMatch(/apply 0(0|1)\d/); // nothing older is replayed
    expect(await dataState(pool)).toEqual(dataBefore);

    const again = run("nycefm_mig_runner");
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).not.toContain("apply ");
    const con = await constraintsOf(pool);
    expect(con["creators.creators_house_id_handle_key"]).toBeDefined();
    expect(con["creators.creators_house_id_key"]).toBeUndefined();
  });
});
