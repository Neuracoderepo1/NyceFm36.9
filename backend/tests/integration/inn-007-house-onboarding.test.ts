import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { buildTestApp, closeAppResources } from "../helpers/app.js";
import { testPool, resetDatabase, closeTestPool } from "../helpers/db.js";
import { createTestUser, loginAgent, type TestUser } from "../helpers/auth.js";

// This file logs in far more times than any single simulated client would
// in production, which trips the app's real per-IP login rate limiter if
// every call shares loginAgent's default X-Forwarded-For. Each call here
// gets its own simulated IP instead -- exercising the real login endpoint
// and its real rate limiter (not bypassing it), just not triggering it
// artificially across unrelated test cases.
let ipSeq = 0;
async function login(app: Express, email: string, password: string) {
  ipSeq++;
  const ip = `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
  return loginAgent(app, email, password, ip);
}

let app: Express;
async function getApp(): Promise<Express> {
  app = app ?? (await buildTestApp());
  return app;
}

async function insertHouse(overrides: { slug?: string; status?: string } = {}): Promise<{ id: string; slug: string }> {
  const slug = overrides.slug ?? `house-${Math.random().toString(36).slice(2, 10)}`;
  const { rows } = await testPool.query<{ id: string }>(
    `INSERT INTO houses (slug, name, house_type, status, timezone) VALUES ($1,'Test House','station',$2,'Africa/Accra') RETURNING id`,
    [slug, overrides.status ?? "active"]
  );
  return { id: rows[0].id, slug };
}

async function addMember(houseId: string, userId: string, role: "owner" | "admin" | "member", status = "active") {
  await testPool.query(
    `INSERT INTO house_members (house_id, user_id, role, status) VALUES ($1,$2,$3,$4)`,
    [houseId, userId, role, status]
  );
}

describe("INN-007: House & Creator onboarding", () => {
  afterEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeAppResources();
    await closeTestPool();
  });

  // -------------------------------------------------------------------
  // Membership: tenancy isolation
  // -------------------------------------------------------------------
  describe("tenancy isolation", () => {
    it("a member of House A cannot read House B's members", async () => {
      const houseA = await insertHouse();
      const houseB = await insertHouse();
      const user = await createTestUser();
      await addMember(houseA.id, user.id, "member");

      const agent = await login(await getApp(), user.email, user.password);
      const res = await agent.get(`/api/houses/${houseB.slug}/members`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("HOUSE_FORBIDDEN");
    });

    it("an admin of House A cannot mutate House B's members", async () => {
      const houseA = await insertHouse();
      const houseB = await insertHouse();
      const admin = await createTestUser();
      const target = await createTestUser();
      await addMember(houseA.id, admin.id, "admin");
      await addMember(houseB.id, target.id, "member");

      const agent = await login(await getApp(), admin.email, admin.password);
      const res = await agent.delete(`/api/houses/${houseB.slug}/members/${target.id}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("HOUSE_FORBIDDEN");
    });

    it("a creator update with a cross-House creatorId fails as not-found (no existence leak)", async () => {
      const houseA = await insertHouse();
      const houseB = await insertHouse();
      const admin = await createTestUser();
      await addMember(houseA.id, admin.id, "admin");
      const creatorInB = await testPool.query<{ id: string }>(
        `INSERT INTO creators (house_id, handle, display_name) VALUES ($1,'other-handle','Other') RETURNING id`,
        [houseB.id]
      );

      const agent = await login(await getApp(), admin.email, admin.password);
      const res = await agent
        .patch(`/api/houses/${houseA.slug}/creators/${creatorInB.rows[0].id}`)
        .send({ displayName: "Hijacked" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("CREATOR_NOT_FOUND");
    });

    it("a creator delete with a cross-House creatorId fails as not-found (no existence leak)", async () => {
      const houseA = await insertHouse();
      const houseB = await insertHouse();
      const admin = await createTestUser();
      await addMember(houseA.id, admin.id, "admin");
      const creatorInB = await testPool.query<{ id: string }>(
        `INSERT INTO creators (house_id, handle, display_name) VALUES ($1,'other-handle','Other') RETURNING id`,
        [houseB.id]
      );

      const agent = await login(await getApp(), admin.email, admin.password);
      const res = await agent.delete(`/api/houses/${houseA.slug}/creators/${creatorInB.rows[0].id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("CREATOR_NOT_FOUND");

      // The row in House B must be untouched -- a 404 here must mean
      // "not visible from this House", never "deleted anyway".
      const stillThere = await testPool.query(`SELECT id FROM creators WHERE id=$1`, [creatorInB.rows[0].id]);
      expect(stillThere.rowCount).toBe(1);
    });

    it("platform role is not a House role: a platform SUPER_ADMIN with no House membership is still HOUSE_FORBIDDEN", async () => {
      const house = await insertHouse();
      const platformSuperAdmin = await createTestUser({ roles: ["SUPER_ADMIN"] });

      const agent = await login(await getApp(), platformSuperAdmin.email, platformSuperAdmin.password);
      const res = await agent.get(`/api/houses/${house.slug}/members`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("HOUSE_FORBIDDEN");
    });
  });

  // -------------------------------------------------------------------
  // Membership CRUD & role enforcement
  // -------------------------------------------------------------------
  describe("membership authorization", () => {
    it("member (read-only) cannot add a member", async () => {
      const house = await insertHouse();
      const member = await createTestUser();
      const target = await createTestUser();
      await addMember(house.id, member.id, "member");

      const agent = await login(await getApp(), member.email, member.password);
      const res = await agent.post(`/api/houses/${house.slug}/members`).send({ email: target.email });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("HOUSE_ROLE_FORBIDDEN");
    });

    it("admin can invite a member, who accepts and becomes active", async () => {
      const house = await insertHouse();
      const admin = await createTestUser();
      const target = await createTestUser();
      await addMember(house.id, admin.id, "admin");

      const adminAgent = await login(await getApp(), admin.email, admin.password);
      const inviteRes = await adminAgent.post(`/api/houses/${house.slug}/members`).send({ email: target.email, role: "member" });
      expect(inviteRes.status).toBe(201);
      expect(inviteRes.body.member.status).toBe("invited");

      const targetAgent = await login(await getApp(), target.email, target.password);
      const acceptRes = await targetAgent.post(`/api/houses/${house.slug}/members/accept`);
      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.member.status).toBe("active");
    });

    it("invited (not-yet-accepted) member cannot administer", async () => {
      const house = await insertHouse();
      const invited = await createTestUser();
      await addMember(house.id, invited.id, "admin", "invited");

      const agent = await login(await getApp(), invited.email, invited.password);
      const res = await agent.get(`/api/houses/${house.slug}/members`);
      expect(res.status).toBe(403); // attachHouseAuth requires status = 'active'
    });

    it("suspended member cannot administer", async () => {
      const house = await insertHouse();
      const suspended = await createTestUser();
      await addMember(house.id, suspended.id, "admin", "suspended");

      const agent = await login(await getApp(), suspended.email, suspended.password);
      const res = await agent.get(`/api/houses/${house.slug}/members`);
      expect(res.status).toBe(403);
    });

    it("mass-assignment: role='owner' in the invite body is rejected by validation, not silently downgraded", async () => {
      const house = await insertHouse();
      const admin = await createTestUser();
      const target = await createTestUser();
      await addMember(house.id, admin.id, "admin");

      const agent = await login(await getApp(), admin.email, admin.password);
      const res = await agent.post(`/api/houses/${house.slug}/members`).send({ email: target.email, role: "owner" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("PATCH cannot set a member's role to owner (ownership transfer is the only path)", async () => {
      const house = await insertHouse();
      const owner = await createTestUser();
      const admin = await createTestUser();
      await addMember(house.id, owner.id, "owner");
      await addMember(house.id, admin.id, "admin");

      const agent = await login(await getApp(), owner.email, owner.password);
      const res = await agent.patch(`/api/houses/${house.slug}/members/${admin.id}`).send({ role: "owner" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("admin cannot demote or remove the owner via PATCH/DELETE", async () => {
      const house = await insertHouse();
      const owner = await createTestUser();
      const admin = await createTestUser();
      await addMember(house.id, owner.id, "owner");
      await addMember(house.id, admin.id, "admin");

      const agent = await login(await getApp(), admin.email, admin.password);
      const patchRes = await agent.patch(`/api/houses/${house.slug}/members/${owner.id}`).send({ status: "suspended" });
      expect(patchRes.status).toBe(409);
      expect(patchRes.body.error.code).toBe("OWNER_REQUIRES_TRANSFER");

      const deleteRes = await agent.delete(`/api/houses/${house.slug}/members/${owner.id}`);
      expect(deleteRes.status).toBe(409);
      expect(deleteRes.body.error.code).toBe("OWNER_REQUIRES_TRANSFER");
    });

    it("admin cannot modify their own membership row", async () => {
      const house = await insertHouse();
      const owner = await createTestUser();
      const admin = await createTestUser();
      await addMember(house.id, owner.id, "owner");
      await addMember(house.id, admin.id, "admin");

      const agent = await login(await getApp(), admin.email, admin.password);
      const res = await agent.patch(`/api/houses/${house.slug}/members/${admin.id}`).send({ status: "suspended" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("CANNOT_MODIFY_SELF");
    });
  });

  // -------------------------------------------------------------------
  // No claim endpoint / ownerless-House bootstrap
  // -------------------------------------------------------------------
  describe("ownership: no arbitrary claim, controlled bootstrap only", () => {
    it("there is no generic /claim endpoint", async () => {
      const house = await insertHouse();
      const member = await createTestUser();
      await addMember(house.id, member.id, "member");
      const agent = await login(await getApp(), member.email, member.password);
      const res = await agent.post(`/api/houses/${house.slug}/claim`);
      // Authenticated AND a member of this House -- if a /claim route existed
      // at all, this is exactly the request that would hit it. It must not
      // exist as a route (404), regardless of what it would have done.
      expect(res.status).toBe(404);
    });

    it("a listener cannot bootstrap an ownerless House", async () => {
      const house = await insertHouse(); // no owner seeded
      const listener = await createTestUser({ roles: ["LISTENER"] });
      const agent = await login(await getApp(), listener.email, listener.password);
      const res = await agent.post(`/api/houses/${house.slug}/ownership/bootstrap`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("PLATFORM_SUPER_ADMIN_REQUIRED");
    });

    it("a platform ADMIN (not SUPER_ADMIN) cannot bootstrap", async () => {
      const house = await insertHouse();
      const admin = await createTestUser({ roles: ["ADMIN"] });
      const agent = await login(await getApp(), admin.email, admin.password);
      const res = await agent.post(`/api/houses/${house.slug}/ownership/bootstrap`);
      expect(res.status).toBe(403);
    });

    it("a platform SUPER_ADMIN can bootstrap an ownerless House as its own owner", async () => {
      const house = await insertHouse();
      const superAdmin = await createTestUser({ roles: ["SUPER_ADMIN"] });
      const agent = await login(await getApp(), superAdmin.email, superAdmin.password);
      const res = await agent.post(`/api/houses/${house.slug}/ownership/bootstrap`);
      expect(res.status).toBe(201);
      expect(res.body.ownerId).toBe(superAdmin.id);

      const row = await testPool.query(`SELECT role, status FROM house_members WHERE house_id=$1 AND user_id=$2`, [
        house.id,
        superAdmin.id,
      ]);
      expect(row.rows[0]).toEqual({ role: "owner", status: "active" });
    });

    it("bootstrap is rejected once the House already has an active owner", async () => {
      const house = await insertHouse();
      const existingOwner = await createTestUser();
      await addMember(house.id, existingOwner.id, "owner");
      const superAdmin = await createTestUser({ roles: ["SUPER_ADMIN"] });

      const agent = await login(await getApp(), superAdmin.email, superAdmin.password);
      const res = await agent.post(`/api/houses/${house.slug}/ownership/bootstrap`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("HOUSE_ALREADY_HAS_OWNER");
    });
  });

  // -------------------------------------------------------------------
  // Ownership transfer
  // -------------------------------------------------------------------
  describe("ownership transfer", () => {
    it("owner can transfer to an active member; previous owner becomes admin", async () => {
      const house = await insertHouse();
      const owner = await createTestUser();
      const member = await createTestUser();
      await addMember(house.id, owner.id, "owner");
      await addMember(house.id, member.id, "member");

      const agent = await login(await getApp(), owner.email, owner.password);
      const res = await agent.post(`/api/houses/${house.slug}/ownership/transfer`).send({ targetUserId: member.id });
      expect(res.status).toBe(200);

      const rows = await testPool.query(`SELECT user_id, role FROM house_members WHERE house_id=$1 ORDER BY user_id`, [house.id]);
      const byId = Object.fromEntries(rows.rows.map((r) => [r.user_id, r.role]));
      expect(byId[member.id]).toBe("owner");
      expect(byId[owner.id]).toBe("admin");
    });

    it("admin cannot transfer ownership", async () => {
      const house = await insertHouse();
      const owner = await createTestUser();
      const admin = await createTestUser();
      const member = await createTestUser();
      await addMember(house.id, owner.id, "owner");
      await addMember(house.id, admin.id, "admin");
      await addMember(house.id, member.id, "member");

      const agent = await login(await getApp(), admin.email, admin.password);
      const res = await agent.post(`/api/houses/${house.slug}/ownership/transfer`).send({ targetUserId: member.id });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("HOUSE_ROLE_FORBIDDEN");
    });

    it("transfer target must belong to the same House (cross-House target rejected)", async () => {
      const houseA = await insertHouse();
      const houseB = await insertHouse();
      const owner = await createTestUser();
      const outsider = await createTestUser();
      await addMember(houseA.id, owner.id, "owner");
      await addMember(houseB.id, outsider.id, "member");

      const agent = await login(await getApp(), owner.email, owner.password);
      const res = await agent.post(`/api/houses/${houseA.slug}/ownership/transfer`).send({ targetUserId: outsider.id });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("TARGET_NOT_A_MEMBER");
    });

    it.each(["invited", "suspended", "removed"])("transfer target with status '%s' is rejected", async (status) => {
      const house = await insertHouse();
      const owner = await createTestUser();
      const target = await createTestUser();
      await addMember(house.id, owner.id, "owner");
      await addMember(house.id, target.id, "member", status);

      const agent = await login(await getApp(), owner.email, owner.password);
      const res = await agent.post(`/api/houses/${house.slug}/ownership/transfer`).send({ targetUserId: target.id });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("TARGET_NOT_ACTIVE");
    });

    it("cannot transfer ownership to yourself", async () => {
      const house = await insertHouse();
      const owner = await createTestUser();
      await addMember(house.id, owner.id, "owner");

      const agent = await login(await getApp(), owner.email, owner.password);
      const res = await agent.post(`/api/houses/${house.slug}/ownership/transfer`).send({ targetUserId: owner.id });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_TRANSFER_TARGET");
    });

    it("transfer is atomic: exactly one owner exists before and after", async () => {
      const house = await insertHouse();
      const owner = await createTestUser();
      const member = await createTestUser();
      await addMember(house.id, owner.id, "owner");
      await addMember(house.id, member.id, "member");

      const countOwners = async () =>
        Number(
          (await testPool.query(`SELECT count(*)::int c FROM house_members WHERE house_id=$1 AND role='owner' AND status='active'`, [
            house.id,
          ])).rows[0].c
        );

      expect(await countOwners()).toBe(1);
      const agent = await login(await getApp(), owner.email, owner.password);
      await agent.post(`/api/houses/${house.slug}/ownership/transfer`).send({ targetUserId: member.id });
      expect(await countOwners()).toBe(1);
    });

    it("concurrent transfer attempts to two different targets: exactly one succeeds, final state has exactly one owner", async () => {
      const house = await insertHouse();
      const owner = await createTestUser();
      const memberA = await createTestUser();
      const memberB = await createTestUser();
      await addMember(house.id, owner.id, "owner");
      await addMember(house.id, memberA.id, "member");
      await addMember(house.id, memberB.id, "member");

      const agent = await login(await getApp(), owner.email, owner.password);
      const [resA, resB] = await Promise.all([
        agent.post(`/api/houses/${house.slug}/ownership/transfer`).send({ targetUserId: memberA.id }),
        agent.post(`/api/houses/${house.slug}/ownership/transfer`).send({ targetUserId: memberB.id }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      // Exactly one of the two concurrent transfers must succeed (200).
      // The loser can legitimately be rejected two different ways depending
      // on scheduling: either its own pre-transaction "are you still the
      // active owner" check already sees the change (403 HOUSE_ROLE_FORBIDDEN,
      // if the winner's whole request completed first), or it passes that
      // check but loses the race for the per-house advisory lock and is
      // rejected by the in-transaction re-check instead (409
      // OWNER_STATE_CHANGED). Both are correct rejections of the same
      // race; asserting a specific one would make this test depend on
      // Node's scheduling, not on the actual security invariant.
      expect(statuses[0]).toBe(200);
      expect([403, 409]).toContain(statuses[1]);

      const ownerRows = await testPool.query(
        `SELECT count(*)::int c FROM house_members WHERE house_id=$1 AND role='owner' AND status='active'`,
        [house.id]
      );
      expect(ownerRows.rows[0].c).toBe(1);
    });
  });

  // -------------------------------------------------------------------
  // Creators
  // -------------------------------------------------------------------
  describe("creator management", () => {
    it("owner and admin can create creators; member cannot", async () => {
      const house = await insertHouse();
      const owner = await createTestUser();
      const member = await createTestUser();
      await addMember(house.id, owner.id, "owner");
      await addMember(house.id, member.id, "member");

      const ownerAgent = await login(await getApp(), owner.email, owner.password);
      const okRes = await ownerAgent.post(`/api/houses/${house.slug}/creators`).send({ handle: "dj-nyce", displayName: "DJ NYCE" });
      expect(okRes.status).toBe(201);

      const memberAgent = await login(await getApp(), member.email, member.password);
      const forbiddenRes = await memberAgent
        .post(`/api/houses/${house.slug}/creators`)
        .send({ handle: "cohost", displayName: "Cohost" });
      expect(forbiddenRes.status).toBe(403);
    });

    it("duplicate handle within the same House fails; same handle in another House succeeds", async () => {
      const houseA = await insertHouse();
      const houseB = await insertHouse();
      const adminA = await createTestUser();
      const adminB = await createTestUser();
      await addMember(houseA.id, adminA.id, "admin");
      await addMember(houseB.id, adminB.id, "admin");

      const agentA = await login(await getApp(), adminA.email, adminA.password);
      const first = await agentA.post(`/api/houses/${houseA.slug}/creators`).send({ handle: "nyce", displayName: "A" });
      expect(first.status).toBe(201);
      const dupe = await agentA.post(`/api/houses/${houseA.slug}/creators`).send({ handle: "nyce", displayName: "A2" });
      expect(dupe.status).toBe(409);
      expect(dupe.body.error.code).toBe("CREATOR_HANDLE_TAKEN");

      const agentB = await login(await getApp(), adminB.email, adminB.password);
      const other = await agentB.post(`/api/houses/${houseB.slug}/creators`).send({ handle: "nyce", displayName: "B" });
      expect(other.status).toBe(201);
    });

    it("multiple creators with distinct handles are supported in one House", async () => {
      const house = await insertHouse();
      const admin = await createTestUser();
      await addMember(house.id, admin.id, "admin");
      const agent = await login(await getApp(), admin.email, admin.password);

      for (const handle of ["nyce", "cohost", "producer"]) {
        const res = await agent.post(`/api/houses/${house.slug}/creators`).send({ handle, displayName: handle });
        expect(res.status).toBe(201);
      }
      const list = await agent.get(`/api/houses/${house.slug}/creators`);
      expect(list.body.creators.map((c: { handle: string }) => c.handle).sort()).toEqual(["cohost", "nyce", "producer"]);
    });

    it("arbitrary house_id in the request body is ignored -- the creator is scoped to the route's House", async () => {
      const house = await insertHouse();
      const otherHouse = await insertHouse();
      const admin = await createTestUser();
      await addMember(house.id, admin.id, "admin");
      const agent = await login(await getApp(), admin.email, admin.password);

      const res = await agent
        .post(`/api/houses/${house.slug}/creators`)
        .send({ handle: "nyce", displayName: "DJ", house_id: otherHouse.id });
      expect(res.status).toBe(201);

      const row = await testPool.query(`SELECT house_id FROM creators WHERE id=$1`, [res.body.creator.id]);
      expect(row.rows[0].house_id).toBe(house.id); // not otherHouse.id
    });

    it("owner and admin can delete a creator; member cannot", async () => {
      const house = await insertHouse();
      const owner = await createTestUser();
      const member = await createTestUser();
      await addMember(house.id, owner.id, "owner");
      await addMember(house.id, member.id, "member");
      const created = await testPool.query<{ id: string }>(
        `INSERT INTO creators (house_id, handle, display_name) VALUES ($1,'dj-nyce','DJ NYCE') RETURNING id`,
        [house.id]
      );
      const creatorId = created.rows[0].id;

      const memberAgent = await login(await getApp(), member.email, member.password);
      const forbiddenRes = await memberAgent.delete(`/api/houses/${house.slug}/creators/${creatorId}`);
      expect(forbiddenRes.status).toBe(403);

      const ownerAgent = await login(await getApp(), owner.email, owner.password);
      const okRes = await ownerAgent.delete(`/api/houses/${house.slug}/creators/${creatorId}`);
      expect(okRes.status).toBe(204);

      const row = await testPool.query(`SELECT id FROM creators WHERE id=$1`, [creatorId]);
      expect(row.rowCount).toBe(0);
    });

    it("deleting the House's only creator is allowed -- creators have no 'last one' invariant", async () => {
      const house = await insertHouse();
      const admin = await createTestUser();
      await addMember(house.id, admin.id, "admin");
      const agent = await login(await getApp(), admin.email, admin.password);

      const created = await agent.post(`/api/houses/${house.slug}/creators`).send({ handle: "solo", displayName: "Solo" });
      expect(created.status).toBe(201);

      const del = await agent.delete(`/api/houses/${house.slug}/creators/${created.body.creator.id}`);
      expect(del.status).toBe(204);

      // The House itself must still resolve fine with zero creators --
      // resolveHouse()/resolvePublicHouse() already model creator as
      // nullable, so this is not a degraded state.
      const houseRes = await agent.get(`/api/houses/${house.slug}`);
      expect(houseRes.status).toBe(200);
      expect(houseRes.body.creator).toBeNull();
    });

    it("deleting a nonexistent creatorId returns 404", async () => {
      const house = await insertHouse();
      const admin = await createTestUser();
      await addMember(house.id, admin.id, "admin");
      const agent = await login(await getApp(), admin.email, admin.password);

      const res = await agent.delete(`/api/houses/${house.slug}/creators/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("CREATOR_NOT_FOUND");
    });
  });

  // -------------------------------------------------------------------
  // INN-006 regression
  // -------------------------------------------------------------------
  describe("INN-006 regression", () => {
    it("GET /:house/public still requires no authentication after INN-007 changes", async () => {
      const house = await insertHouse();
      const res = await request(await getApp()).get(`/api/houses/${house.slug}/public`);
      expect(res.status).toBe(200);
    });

    it("authenticated House routes still reject unauthenticated requests", async () => {
      const house = await insertHouse();
      const res = await request(await getApp()).get(`/api/houses/${house.slug}/members`);
      expect(res.status).toBe(401);
    });
  });
});
