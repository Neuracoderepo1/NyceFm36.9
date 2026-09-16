import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { buildTestApp, closeAppResources } from "../helpers/app.js";
import { getDefaultStationRow, testPool, resetDatabase, closeTestPool } from "../helpers/db.js";

let app: Express;

async function getApp(): Promise<Express> {
  app = app ?? (await buildTestApp());
  return app;
}

async function insertHouse(overrides: { slug?: string; status?: string } = {}) {
  const slug = overrides.slug ?? `listener-house-${Math.random().toString(36).slice(2, 10)}`;

  const { rows } = await testPool.query<{ id: string; slug: string }>(
    `INSERT INTO houses (slug, name, house_type, status, timezone)
     VALUES ($1, 'Listener Test House', 'station', $2, 'Africa/Accra')
     RETURNING id, slug`,
    [slug, overrides.status ?? "active"],
  );

  return rows[0];
}

async function insertStation() {
  const slug = `listener-station-${Math.random().toString(36).slice(2, 10)}`;

  const { rows } = await testPool.query<{ id: string; slug: string; name: string; timezone: string }>(
    `INSERT INTO stations (slug, name, timezone)
     VALUES ($1, 'Listener Test Station', 'Africa/Accra')
     RETURNING id, slug, name, timezone`,
    [slug],
  );

  return rows[0];
}

async function attachStationChannel(houseId: string, stationId?: string) {
  const station = stationId
    ? (
        await testPool.query<{ id: string; slug: string; name: string; timezone: string }>(
          `SELECT id, slug, name, timezone
             FROM stations
            WHERE id = $1`,
          [stationId],
        )
      ).rows[0]
    : await getDefaultStationRow();

  if (!station) {
    throw new Error("Test station not found");
  }

  await testPool.query(
    `INSERT INTO channels
      (house_id, slug, name, channel_type, status, legacy_station_id)
     VALUES ($1, 'main', 'Main Channel', 'radio', 'active', $2)`,
    [houseId, station.id],
  );

  return station;
}

async function insertCreator(houseId: string) {
  await testPool.query(
    `INSERT INTO creators (house_id, handle, display_name, bio, avatar_key)
     VALUES ($1, 'dj-nyce', 'DJ Nyce', 'NYCE FM creator', 'avatar-key')
     RETURNING id`,
    [houseId],
  );
}

async function insertMediaAsset(stationId: string) {
  const { rows } = await testPool.query<{ id: string }>(
    `INSERT INTO media_assets
      (station_id, title, artist, album, duration_ms, mime_type, storage_key, status)
     VALUES ($1, 'Test Track', 'Test Artist', 'Test Album', 180000,
             'audio/mpeg', $2, 'ready')
     RETURNING id`,
    [stationId, `inn-008-${Math.random().toString(36).slice(2, 12)}.mp3`],
  );

  return rows[0].id;
}

async function insertPoll(stationId: string) {
  const { rows } = await testPool.query<{ id: string }>(
    `INSERT INTO audience_polls
      (station_id, question, status, starts_at, ends_at)
     VALUES ($1, 'Which track next?', 'active', NULL, NULL)
     RETURNING id`,
    [stationId],
  );

  const pollId = rows[0].id;

  const option = await testPool.query<{ id: string }>(
    `INSERT INTO audience_poll_options (poll_id, label, position)
     VALUES ($1, 'Track A', 0)
     RETURNING id`,
    [pollId],
  );

  return { pollId, optionId: option.rows[0].id };
}

describe("INN-008: Listener House Experience", () => {
  afterEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeAppResources();
    await closeTestPool();
  });

  describe("public House resolution", () => {
    it("resolves an active House by slug and returns a public DTO", async () => {
      const house = await insertHouse();
      await attachStationChannel(house.id);
      await insertCreator(house.id);

      const res = await request(await getApp()).get(`/api/houses/${house.slug}/listener`);

      expect(res.status).toBe(200);
      expect(res.body.house.slug).toBe(house.slug);
      expect(res.body.house.name).toBe("Listener Test House");
      expect(res.body.house.creator.handle).toBe("dj-nyce");
      expect(res.body.house.channels).toHaveLength(1);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain("house_id");
      expect(body).not.toContain("legacy_station_id");
      expect(body).not.toContain("config");
      expect(body).not.toContain("role");
    });

    it("resolves an active House by UUID", async () => {
      const house = await insertHouse();
      await attachStationChannel(house.id);

      const res = await request(await getApp()).get(`/api/houses/${house.id}/listener`);

      expect(res.status).toBe(200);
      expect(res.body.house.slug).toBe(house.slug);
    });

    it("does not expose suspended or archived Houses", async () => {
      const suspended = await insertHouse({ status: "suspended" });
      const archived = await insertHouse({ status: "archived" });

      const app = await getApp();

      const suspendedRes = await request(app).get(`/api/houses/${suspended.slug}/listener`);
      const archivedRes = await request(app).get(`/api/houses/${archived.slug}/listener`);

      expect(suspendedRes.status).toBe(404);
      expect(archivedRes.status).toBe(404);
    });
  });

  describe("House tenancy", () => {
    it("derives now-playing from the House's active legacy channel", async () => {
      const house = await insertHouse();
      const station = await attachStationChannel(house.id);
      const mediaAssetId = await insertMediaAsset(station.id);

      await testPool.query(
        `INSERT INTO now_playing
          (station_id, media_asset_id, state, elapsed_ms, revision)
         VALUES ($1, $2, 'playing', 42000, 7)`,
        [station.id, mediaAssetId],
      );

      const res = await request(await getApp())
        .get(`/api/houses/${house.slug}/listener/now-playing`);

      expect(res.status).toBe(200);
      expect(res.body.nowPlaying.title).toBe("Test Track");
      expect(res.body.nowPlaying.artist).toBe("Test Artist");
      expect(res.body.nowPlaying.elapsedMs).toBe(42000);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain(station.id);
      expect(body).not.toContain("station_id");
      expect(body).not.toContain("media_asset_id");
    });

    it("rejects client-supplied house_id and station_id fields", async () => {
      const house = await insertHouse();
      await attachStationChannel(house.id);

      const res = await request(await getApp())
        .post(`/api/houses/${house.slug}/listener/chat`)
        .send({
          body: "hello",
          anonymousId: "stable-anonymous-1",
          house_id: house.id,
          station_id: "not-client-controlled",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_REQUEST");
    });

    it("cannot read another House's chat", async () => {
      const houseA = await insertHouse();
      const houseB = await insertHouse();
      const stationA = await attachStationChannel(houseA.id);
      const stationB = await insertStation();
      await attachStationChannel(houseB.id, stationB.id);

      await testPool.query(
        `INSERT INTO audience_messages
          (station_id, anonymous_id, display_name, body, status)
         VALUES ($1, 'anonymous-house-b', 'House B', 'Private B message', 'visible')`,
        [stationB.id],
      );

      const res = await request(await getApp())
        .get(`/api/houses/${houseA.slug}/listener/chat`);

      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(0);
      expect(JSON.stringify(res.body)).not.toContain("Private B message");

      void stationA;
    });
  });

  describe("chat", () => {
    it("returns only visible messages and accepts anonymous chat", async () => {
      const house = await insertHouse();
      const station = await attachStationChannel(house.id);

      await testPool.query(
        `INSERT INTO audience_messages
          (station_id, anonymous_id, display_name, body, status)
         VALUES
          ($1, 'anonymous-visible', 'Listener', 'Visible message', 'visible'),
          ($1, 'anonymous-hidden', 'Listener', 'Hidden message', 'hidden')`,
        [station.id],
      );

      const app = await getApp();

      const read = await request(app)
        .get(`/api/houses/${house.slug}/listener/chat`);

      expect(read.status).toBe(200);
      expect(read.body.messages).toHaveLength(1);
      expect(read.body.messages[0].body).toBe("Visible message");

      const write = await request(app)
        .post(`/api/houses/${house.slug}/listener/chat`)
        .send({
          anonymousId: "stable-anonymous-chat",
          displayName: "Listener",
          body: "Hello NYCE FM",
        });

      expect(write.status).toBe(201);
      expect(write.body.message.body).toBe("Hello NYCE FM");
      expect(write.body.anonymousId).toBe("stable-anonymous-chat");
    });

    it("rejects invalid or oversized chat payloads", async () => {
      const house = await insertHouse();
      await attachStationChannel(house.id);

      const res = await request(await getApp())
        .post(`/api/houses/${house.slug}/listener/chat`)
        .send({
          anonymousId: "stable-anonymous-chat",
          body: "x".repeat(501),
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_REQUEST");
    });
  });

  describe("polls", () => {
    it("returns only active and currently in-window polls", async () => {
      const house = await insertHouse();
      const station = await attachStationChannel(house.id);
      const { pollId, optionId } = await insertPoll(station.id);

      await testPool.query(
        `INSERT INTO audience_polls
          (station_id, question, status)
         VALUES ($1, 'Closed poll', 'closed')`,
        [station.id],
      );

      const res = await request(await getApp())
        .get(`/api/houses/${house.slug}/listener/polls`);

      expect(res.status).toBe(200);
      expect(res.body.polls).toHaveLength(1);
      expect(res.body.polls[0].id).toBe(pollId);
      expect(res.body.polls[0].options[0].id).toBe(optionId);
    });

    it("requires a stable anonymous ID for anonymous voting and makes duplicate votes idempotent", async () => {
      const house = await insertHouse();
      const station = await attachStationChannel(house.id);
      const { pollId, optionId } = await insertPoll(station.id);
      const app = await getApp();

      const missingIdentity = await request(app)
        .post(`/api/houses/${house.slug}/listener/polls/${pollId}/vote`)
        .send({ optionId });

      expect(missingIdentity.status).toBe(400);
      expect(missingIdentity.body.error).toBe("ANONYMOUS_ID_REQUIRED");

      const first = await request(app)
        .post(`/api/houses/${house.slug}/listener/polls/${pollId}/vote`)
        .send({ optionId, anonymousId: "stable-voter-1" });

      const second = await request(app)
        .post(`/api/houses/${house.slug}/listener/polls/${pollId}/vote`)
        .send({ optionId, anonymousId: "stable-voter-1" });

      expect(first.status).toBe(201);
      expect(first.body.recorded).toBe(true);
      expect(second.status).toBe(200);
      expect(second.body.recorded).toBe(false);

      const count = await testPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM audience_poll_votes
          WHERE poll_id = $1`,
        [pollId],
      );

      expect(count.rows[0].count).toBe("1");
    });

    it("cannot vote on another House's poll or option", async () => {
      const houseA = await insertHouse();
      const houseB = await insertHouse();
      const stationA = await attachStationChannel(houseA.id);
      const stationB = await insertStation();
      await attachStationChannel(houseB.id, stationB.id);
      const pollB = await insertPoll(stationB.id);

      const res = await request(await getApp())
        .post(`/api/houses/${houseA.slug}/listener/polls/${pollB.pollId}/vote`)
        .send({
          optionId: pollB.optionId,
          anonymousId: "cross-house-voter",
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("POLL_NOT_FOUND");

      void stationA;
    });
  });

  describe("presence, reactions, requests and dedications", () => {
    it("scopes presence to the House's derived station", async () => {
      const house = await insertHouse();
      const station = await attachStationChannel(house.id);

      const res = await request(await getApp())
        .post(`/api/houses/${house.slug}/listener/presence`)
        .send({ anonymousId: "presence-listener-1" });

      expect(res.status).toBe(204);

      const rows = await testPool.query<{ station_id: string; anonymous_id: string }>(
        `SELECT station_id, anonymous_id
           FROM listener_presence
          WHERE anonymous_id = 'presence-listener-1'`,
      );

      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].station_id).toBe(station.id);
    });

    it("rejects a reaction media asset belonging to another House", async () => {
      const houseA = await insertHouse();
      const houseB = await insertHouse();
      await attachStationChannel(houseA.id);
      const stationB = await insertStation();
      await attachStationChannel(houseB.id, stationB.id);
      const foreignAsset = await insertMediaAsset(stationB.id);

      const res = await request(await getApp())
        .post(`/api/houses/${houseA.slug}/listener/reactions`)
        .send({
          anonymousId: "reaction-listener-1",
          reaction: "love",
          mediaAssetId: foreignAsset,
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("MEDIA_ASSET_NOT_FOUND");
    });

    it("rejects a request for a media asset belonging to another House", async () => {
      const houseA = await insertHouse();
      const houseB = await insertHouse();
      await attachStationChannel(houseA.id);
      const stationB = await insertStation();
      await attachStationChannel(houseB.id, stationB.id);
      const foreignAsset = await insertMediaAsset(stationB.id);

      const res = await request(await getApp())
        .post(`/api/houses/${houseA.slug}/listener/requests`)
        .send({
          anonymousId: "request-listener-1",
          mediaAssetId: foreignAsset,
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("MEDIA_ASSET_NOT_FOUND");
    });

    it("creates a House-scoped dedication without accepting arbitrary tenancy fields", async () => {
      const house = await insertHouse();
      await attachStationChannel(house.id);

      const res = await request(await getApp())
        .post(`/api/houses/${house.slug}/listener/dedications`)
        .send({
          anonymousId: "dedication-listener-1",
          recipientName: "Ama",
          message: "This one is for you",
          house_id: house.id,
          station_id: "foreign-station",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_REQUEST");
    });
  });

  describe("rate limiting", () => {
    it("eventually returns 429 for repeated public listener requests", async () => {
      const house = await insertHouse();
      await attachStationChannel(house.id);

      const app = await getApp();
      let rateLimited = false;

      for (let i = 0; i < 65; i++) {
        const res = await request(app)
          .get(`/api/houses/${house.slug}/listener/now-playing`);

        if (res.status === 429) {
          rateLimited = true;
          break;
        }
      }

      expect(rateLimited).toBe(true);
    });
  });
});
