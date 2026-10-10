import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import { buildTestApp, closeAppResources } from "../helpers/app.js";
import { testPool, resetDatabase, closeTestPool, getDefaultStationRow } from "../helpers/db.js";
import { createTestUser, loginAgent } from "../helpers/auth.js";

// Canonical INNHOUSE model (migration 021): many creators per House, three House roles,
// one active owner per House, constrained House/channel types, tenant isolation.

let ipSeq = 0;
async function login(app: Express, email: string, password: string) {
  ipSeq++;
  return loginAgent(app, email, password, `10.9.${(ipSeq >> 8) & 255}.${ipSeq & 255}`);
}

let app: Express;
async function getApp(): Promise<Express> {
  app = app ?? (await buildTestApp());
  return app;
}

async function insertHouse(slug = `house-${Math.random().toString(36).slice(2, 10)}`, houseType = "station") {
  const { rows } = await testPool.query<{ id: string }>(
    `INSERT INTO houses (slug, name, house_type, status, timezone) VALUES ($1,'Test House',$2,'active','Africa/Accra') RETURNING id`,
    [slug, houseType]
  );
  return { id: rows[0].id, slug };
}

async function addMember(houseId: string, userId: string, role: string, status = "active") {
  await testPool.query(`INSERT INTO house_members (house_id, user_id, role, status) VALUES ($1,$2,$3,$4)`, [
    houseId,
    userId,
    role,
    status,
  ]);
}

type PgErr = { code?: string; constraint?: string; message: string };
async function pgError(p: Promise<unknown>): Promise<PgErr> {
  try {
    await p;
  } catch (e) {
    return e as PgErr;
  }
  throw new Error("expected a Postgres error but the statement succeeded");
}

async function asRole(role: "anon" | "authenticated", sql: string, params: unknown[] = []) {
  const client = await testPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    return await client.query(sql, params);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("INN-009: canonical INNHOUSE schema", () => {
  afterEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeAppResources();
    await closeTestPool();
  });

  describe("creators: multiple per House", () => {
    it("an owner can create several creators in one House and list them all", async () => {
      const house = await insertHouse();
      const owner = await createTestUser();
      await addMember(house.id, owner.id, "owner");
      const agent = await login(await getApp(), owner.email, owner.password);

      for (const handle of ["alpha", "bravo", "charlie"]) {
        const res = await agent.post(`/api/houses/${house.slug}/creators`).send({ handle, displayName: handle.toUpperCase() });
        expect(res.status).toBe(201);
      }
      const list = await agent.get(`/api/houses/${house.slug}/creators`);
      expect(list.status).toBe(200);
      expect(list.body.creators.map((c: { handle: string }) => c.handle).sort()).toEqual(["alpha", "bravo", "charlie"]);
    });

    it("the same handle can exist in two different Houses", async () => {
      const a = await insertHouse();
      const b = await insertHouse();
      const ownerA = await createTestUser();
      const ownerB = await createTestUser();
      await addMember(a.id, ownerA.id, "owner");
      await addMember(b.id, ownerB.id, "owner");
      const agentA = await login(await getApp(), ownerA.email, ownerA.password);
      const agentB = await login(await getApp(), ownerB.email, ownerB.password);

      expect((await agentA.post(`/api/houses/${a.slug}/creators`).send({ handle: "shared", displayName: "A" })).status).toBe(201);
      expect((await agentB.post(`/api/houses/${b.slug}/creators`).send({ handle: "shared", displayName: "B" })).status).toBe(201);
    });

    it("a duplicate handle inside one House is a 409, not a server error", async () => {
      const house = await insertHouse();
      const owner = await createTestUser();
      await addMember(house.id, owner.id, "owner");
      const agent = await login(await getApp(), owner.email, owner.password);

      await agent.post(`/api/houses/${house.slug}/creators`).send({ handle: "dup", displayName: "One" });
      const res = await agent.post(`/api/houses/${house.slug}/creators`).send({ handle: "dup", displayName: "Two" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CREATOR_HANDLE_TAKEN");
    });

    it("a plain member cannot create creators; an admin can", async () => {
      const house = await insertHouse();
      const member = await createTestUser();
      const admin = await createTestUser();
      await addMember(house.id, member.id, "member");
      await addMember(house.id, admin.id, "admin");

      const m = await login(await getApp(), member.email, member.password);
      const a = await login(await getApp(), admin.email, admin.password);
      expect((await m.post(`/api/houses/${house.slug}/creators`).send({ handle: "nope", displayName: "No" })).status).toBe(403);
      expect((await a.post(`/api/houses/${house.slug}/creators`).send({ handle: "yes", displayName: "Yes" })).status).toBe(201);
    });

    it("public House views are deterministic with several creators: the earliest creator is shown", async () => {
      const house = await insertHouse();
      // The earliest creator deliberately has the HIGHEST uuid, so a query that
      // picks "some" creator (sorted/grouped by id) cannot return it by accident.
      await testPool.query(
        `INSERT INTO creators (id, house_id, handle, display_name, created_at) VALUES
           ('00000000-0000-4000-8000-000000000001',$1,'late-a','Late A', now()),
           ('00000000-0000-4000-8000-000000000002',$1,'late-b','Late B', now() - interval '1 minute'),
           ('00000000-0000-4000-8000-000000000003',$1,'late-c','Late C', now() - interval '1 hour'),
           ('ffffffff-ffff-4fff-8fff-ffffffffffff',$1,'early','Early', now() - interval '1 day')`,
        [house.id]
      );
      const { default: request } = await import("supertest");
      for (const path of [`/api/houses/${house.slug}/public`, `/api/houses/${house.slug}/listener`]) {
        const body = (await request(await getApp()).get(path)).body;
        const creator = body.creator ?? body.house?.creator;
        expect(creator?.handle, path).toBe("early");
      }
    });

    it("the listener view lists each channel once even with several creators", async () => {
      const house = await insertHouse();
      await testPool.query(
        `INSERT INTO creators (house_id, handle, display_name) VALUES ($1,'c1','C1'),($1,'c2','C2')`,
        [house.id]
      );
      await testPool.query(
        `INSERT INTO channels (house_id, slug, name, channel_type, status) VALUES ($1,'main','Main','radio','active')`,
        [house.id]
      );
      const { default: request } = await import("supertest");
      const res = await request(await getApp()).get(`/api/houses/${house.slug}/listener`);
      expect(res.status).toBe(200);
      expect(res.body.house.channels).toHaveLength(1);
    });
  });

  describe("database constraints (canonical model)", () => {
    it("accepts every canonical house_type and rejects anything else", async () => {
      for (const t of ["station", "creator", "brand", "community", "organization"]) {
        await insertHouse(undefined, t);
      }
      const err = await pgError(insertHouse(undefined, "spaceship"));
      expect(err.code).toBe("23514");
      expect(err.constraint).toBe("houses_house_type_check");
    });

    it("accepts every canonical channel_type and rejects anything else", async () => {
      const house = await insertHouse();
      for (const t of ["radio", "broadcast", "content", "community", "live", "other"]) {
        await testPool.query(`INSERT INTO channels (house_id, slug, name, channel_type) VALUES ($1,$2,'C',$3)`, [house.id, `c-${t}`, t]);
      }
      const err = await pgError(
        testPool.query(`INSERT INTO channels (house_id, slug, name, channel_type) VALUES ($1,'bad','C','podcast')`, [house.id])
      );
      expect(err.constraint).toBe("channels_channel_type_check");
    });

    it("allows exactly three House roles", async () => {
      const house = await insertHouse();
      const users = await Promise.all([createTestUser(), createTestUser(), createTestUser(), createTestUser(), createTestUser()]);
      await addMember(house.id, users[0].id, "owner");
      await addMember(house.id, users[1].id, "admin");
      await addMember(house.id, users[2].id, "member");
      for (const [i, role] of [[3, "editor"], [4, "moderator"]] as const) {
        const err = await pgError(addMember(house.id, users[i].id, role));
        expect(err.constraint).toBe("house_members_role_check");
      }
    });

    it("refuses a second ACTIVE owner at the database level, but allows a suspended former owner", async () => {
      const house = await insertHouse();
      const [o1, o2, o3] = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
      await addMember(house.id, o1.id, "owner");
      const err = await pgError(addMember(house.id, o2.id, "owner"));
      expect(err.code).toBe("23505");
      expect(err.constraint).toBe("uq_house_members_one_active_owner");

      // A non-active owner row does not count toward the limit.
      await addMember(house.id, o3.id, "owner", "suspended");
      const { rows } = await testPool.query(
        `SELECT count(*)::int AS n FROM house_members WHERE house_id=$1 AND role='owner' AND status='active'`,
        [house.id]
      );
      expect(rows[0].n).toBe(1);
    });

    it("a legacy station can be wrapped by only one channel (tenant isolation)", async () => {
      const station = await getDefaultStationRow();
      const a = await insertHouse();
      const b = await insertHouse();
      await testPool.query(
        `INSERT INTO channels (house_id, slug, name, channel_type, legacy_station_id) VALUES ($1,'s','S','radio',$2)`,
        [a.id, station.id]
      );
      const err = await pgError(
        testPool.query(
          `INSERT INTO channels (house_id, slug, name, channel_type, legacy_station_id) VALUES ($1,'s','S','radio',$2)`,
          [b.id, station.id]
        )
      );
      expect(err.code).toBe("23505");
    });
  });

  describe("ownership transfer keeps the canonical single-owner invariant", () => {
    it("transfers ownership, leaving exactly one active owner and the old owner as admin", async () => {
      const house = await insertHouse();
      const [owner, target] = await Promise.all([createTestUser(), createTestUser()]);
      await addMember(house.id, owner.id, "owner");
      await addMember(house.id, target.id, "member");
      const agent = await login(await getApp(), owner.email, owner.password);

      const res = await agent.post(`/api/houses/${house.slug}/ownership/transfer`).send({ targetUserId: target.id });
      expect(res.status).toBe(200);

      const { rows } = await testPool.query(
        `SELECT user_id, role FROM house_members WHERE house_id=$1 AND status='active' ORDER BY role`,
        [house.id]
      );
      expect(rows.filter((r) => r.role === "owner")).toEqual([{ user_id: target.id, role: "owner" }]);
      expect(rows.find((r) => r.user_id === owner.id)?.role).toBe("admin");
    });

    it("promoting a second owner before demoting the first is rejected by the database", async () => {
      const house = await insertHouse();
      const [owner, target] = await Promise.all([createTestUser(), createTestUser()]);
      await addMember(house.id, owner.id, "owner");
      await addMember(house.id, target.id, "member");
      const err = await pgError(
        testPool.query(`UPDATE house_members SET role='owner' WHERE house_id=$1 AND user_id=$2`, [house.id, target.id])
      );
      expect(err.constraint).toBe("uq_house_members_one_active_owner");
    });
  });

  describe("authorization boundaries and RLS", () => {
    const tables = ["houses", "creators", "house_members", "channels"];

    it("RLS is enabled on every INNHOUSE table", async () => {
      const { rows } = await testPool.query(
        `SELECT relname, relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND relname = ANY($1)`,
        [tables]
      );
      expect(rows).toHaveLength(4);
      for (const r of rows) expect(r.relrowsecurity, r.relname).toBe(true);
    });

    for (const role of ["anon", "authenticated"] as const) {
      it(`${role} has no direct read or write access to INNHOUSE tables`, async () => {
        const house = await insertHouse();
        for (const t of tables) {
          const read = await pgError(asRole(role, `SELECT * FROM public.${t} LIMIT 1`));
          expect(read.code, `${role} SELECT ${t}`).toBe("42501");
        }
        const write = await pgError(asRole(role, `UPDATE public.houses SET name='pwned' WHERE id=$1`, [house.id]));
        expect(write.code).toBe("42501");
        const del = await pgError(asRole(role, `DELETE FROM public.house_members`));
        expect(del.code).toBe("42501");
        const { rows } = await testPool.query(`SELECT name FROM houses WHERE id=$1`, [house.id]);
        expect(rows[0].name).toBe("Test House");
      });
    }

    it("a member of House A cannot create creators in House B", async () => {
      const a = await insertHouse();
      const b = await insertHouse();
      const admin = await createTestUser();
      await addMember(a.id, admin.id, "admin");
      const agent = await login(await getApp(), admin.email, admin.password);
      const res = await agent.post(`/api/houses/${b.slug}/creators`).send({ handle: "intruder", displayName: "X" });
      expect(res.status).toBe(403);
      const { rows } = await testPool.query(`SELECT count(*)::int AS n FROM creators WHERE house_id=$1`, [b.id]);
      expect(rows[0].n).toBe(0);
    });

    it("an unauthenticated caller cannot reach authenticated House routes", async () => {
      const house = await insertHouse();
      const { default: request } = await import("supertest");
      const res = await request(await getApp()).post(`/api/houses/${house.slug}/creators`).send({ handle: "x1", displayName: "X" });
      expect([401, 403]).toContain(res.status);
    });
  });

  describe("migration 021 repeat-run behaviour (fresh database)", () => {
    it("re-applying 021 is a no-op on a migrated database", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const sql = fs.readFileSync(
        path.resolve(import.meta.dirname, "../../src/db/migrations/021_innhouse_canonical_reconciliation.sql"),
        "utf8"
      );
      const client = await testPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      const house = await insertHouse();
      expect(house.id).toBeTruthy();
    });
  });
});
