import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { buildTestApp, closeAppResources } from "../helpers/app.js";
import { testPool, resetDatabase, closeTestPool } from "../helpers/db.js";

let app: Express;

async function getApp(): Promise<Express> {
  app = app ?? (await buildTestApp());
  return app;
}

async function insertHouse(overrides: {
  slug?: string;
  name?: string;
  houseType?: string;
  status?: string;
  timezone?: string | null;
  config?: object;
} = {}): Promise<{ id: string; slug: string }> {
  const slug = overrides.slug ?? `house-${Math.random().toString(36).slice(2, 10)}`;
  const { rows } = await testPool.query<{ id: string }>(
    `INSERT INTO houses (slug, name, house_type, status, timezone, config)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      slug,
      overrides.name ?? "Test House",
      overrides.houseType ?? "station",
      overrides.status ?? "active",
      overrides.timezone ?? "Africa/Accra",
      JSON.stringify(overrides.config ?? { internal: "should-never-leak" }),
    ]
  );
  return { id: rows[0].id, slug };
}

async function insertCreator(
  houseId: string,
  overrides: { handle?: string; displayName?: string; bio?: string | null; avatarKey?: string | null } = {}
): Promise<void> {
  await testPool.query(
    `INSERT INTO creators (house_id, handle, display_name, bio, avatar_key, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      houseId,
      overrides.handle ?? "dj-nyce",
      overrides.displayName ?? "DJ NYCE",
      overrides.bio ?? "Your favorite host.",
      overrides.avatarKey ?? "avatars/dj-nyce.png",
      JSON.stringify({ internalNote: "should-never-leak" }),
    ]
  );
}

async function insertChannel(
  houseId: string,
  overrides: {
    slug?: string;
    name?: string;
    channelType?: string;
    status?: string;
    legacyStationId?: string | null;
  } = {}
): Promise<void> {
  await testPool.query(
    `INSERT INTO channels (house_id, slug, name, channel_type, status, legacy_station_id, config)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      houseId,
      overrides.slug ?? `channel-${Math.random().toString(36).slice(2, 8)}`,
      overrides.name ?? "Main Channel",
      overrides.channelType ?? "radio",
      overrides.status ?? "active",
      overrides.legacyStationId ?? null,
      JSON.stringify({ internal: "should-never-leak" }),
    ]
  );
}

describe("GET /api/houses/:house/public", () => {
  afterEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeAppResources();
    await closeTestPool();
  });

  it("returns public House/creator/channel data without any session or auth header", async () => {
    const house = await insertHouse({ slug: "nycefm-test", name: "NYCE FM" });
    await insertCreator(house.id, { handle: "dj-nyce", displayName: "DJ NYCE" });
    await insertChannel(house.id, { slug: "main", name: "NYCE FM Main" });

    const res = await request(await getApp()).get(`/api/houses/${house.slug}/public`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      house: {
        slug: "nycefm-test",
        name: "NYCE FM",
        houseType: "station",
        timezone: "Africa/Accra",
      },
      creator: {
        handle: "dj-nyce",
        displayName: "DJ NYCE",
        bio: "Your favorite host.",
        avatarKey: "avatars/dj-nyce.png",
      },
      channels: [
        {
          slug: "main",
          name: "NYCE FM Main",
          channelType: "radio",
        },
      ],
    });
  });

  it("never leaks membership, roles, legacy station ids, internal ids, or raw config", async () => {
    const legacyStation = await testPool.query<{ id: string }>(
      `SELECT id FROM stations ORDER BY created_at ASC LIMIT 1`
    );
    const house = await insertHouse();
    await insertCreator(house.id);
    await insertChannel(house.id, {
      slug: "wraps-legacy",
      legacyStationId: legacyStation.rows[0]?.id ?? null,
    });

    const res = await request(await getApp()).get(`/api/houses/${house.slug}/public`);

    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);

    // No internal UUIDs of any kind (house id, creator id, channel id).
    expect(raw).not.toContain(house.id);
    if (legacyStation.rows[0]?.id) {
      expect(raw).not.toContain(legacyStation.rows[0].id);
    }

    // No field names that would carry membership/role/legacy/internal data.
    expect(res.body.house).not.toHaveProperty("id");
    expect(res.body.house).not.toHaveProperty("config");
    expect(res.body.house).not.toHaveProperty("status");
    expect(res.body).not.toHaveProperty("membership");
    expect(res.body.creator).not.toHaveProperty("id");
    expect(res.body.creator).not.toHaveProperty("metadata");
    for (const channel of res.body.channels) {
      expect(channel).not.toHaveProperty("id");
      expect(channel).not.toHaveProperty("legacyStationId");
      expect(channel).not.toHaveProperty("status");
      expect(channel).not.toHaveProperty("config");
    }

    // And never the literal marker planted in the raw config/metadata blobs.
    expect(raw).not.toContain("should-never-leak");
  });

  it("omits non-active channels from the public response", async () => {
    const house = await insertHouse();
    await insertChannel(house.id, { slug: "live", status: "active" });
    await insertChannel(house.id, { slug: "paused", status: "paused" });
    await insertChannel(house.id, { slug: "archived", status: "archived" });

    const res = await request(await getApp()).get(`/api/houses/${house.slug}/public`);

    expect(res.status).toBe(200);
    expect(res.body.channels.map((c: { slug: string }) => c.slug)).toEqual(["live"]);
  });

  it("returns creator: null when the House has no creator yet", async () => {
    const house = await insertHouse();

    const res = await request(await getApp()).get(`/api/houses/${house.slug}/public`);

    expect(res.status).toBe(200);
    expect(res.body.creator).toBeNull();
  });

  it("resolves by House id as well as slug", async () => {
    const house = await insertHouse();

    const res = await request(await getApp()).get(`/api/houses/${house.id}/public`);

    expect(res.status).toBe(200);
    expect(res.body.house.slug).toBe(house.slug);
  });

  it("returns 404 for an unknown House", async () => {
    const res = await request(await getApp()).get("/api/houses/does-not-exist/public");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("HOUSE_NOT_FOUND");
  });

  it("returns 404 (not the private/suspended House) for a suspended House", async () => {
    const house = await insertHouse({ status: "suspended" });

    const res = await request(await getApp()).get(`/api/houses/${house.slug}/public`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("HOUSE_NOT_FOUND");
  });

  it("returns 404 for an archived House", async () => {
    const house = await insertHouse({ status: "archived" });

    const res = await request(await getApp()).get(`/api/houses/${house.slug}/public`);

    expect(res.status).toBe(404);
  });

  it("still requires auth on the existing authenticated House endpoint (no regression)", async () => {
    const house = await insertHouse();

    const res = await request(await getApp()).get(`/api/houses/${house.slug}`);

    expect(res.status).toBe(401);
  });
});
