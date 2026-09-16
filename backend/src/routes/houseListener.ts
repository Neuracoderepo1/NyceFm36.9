import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { pool } from "../db/pool.js";
import {
  actorFromRequest,
  createDedication,
  createRequest,
  presenceHeartbeat,
  react,
} from "../services/audience.js";
import { getNowPlaying } from "../services/broadcast.js";
import { resolveActiveHouse } from "../middleware/houseAuth.js";

const router = Router();

/**
 * INN-008 Listener House Experience
 *
 * Security model:
 * - House is resolved exclusively from the route parameter.
 * - No request body field may select a House or station.
 * - Listener-facing object IDs are validated against the House's
 *   legacy station/channel linkage.
 * - Public DTOs are allowlisted.
 */

const publicLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: "RATE_LIMITED" });
  },
});

async function listenerHouse(req: Request, res: Response) {
  const houseKey = String(req.params.house || "");
  const house = await resolveActiveHouse(houseKey);

  if (!house) {
    res.status(404).json({ error: "HOUSE_NOT_FOUND" });
    return null;
  }

  return house;
}

function publicHouseDto(row: any) {
  return {
    slug: row.house_slug,
    name: row.house_name,
    houseType: row.house_type,
    timezone: row.timezone,
    creator: row.creator_handle
      ? {
          handle: row.creator_handle,
          displayName: row.creator_display_name,
          bio: row.creator_bio,
          avatarKey: row.creator_avatar_key,
        }
      : null,
    channels: Array.isArray(row.channels)
      ? row.channels
          .filter((channel: any) => channel?.status === "active")
          .map((channel: any) => ({
            slug: channel.slug,
            name: channel.name,
            channelType: channel.channel_type,
          }))
      : [],
  };
}

function nowPlayingDto(row: any) {
  if (!row) return null;

  return {
    state: row.state,
    title: row.title ?? null,
    artist: row.artist ?? null,
    album: row.album ?? null,
    durationMs: row.duration_ms ?? null,
    elapsedMs: row.elapsed_ms ?? null,
    coverArtKey: row.cover_art_key ?? null,
  };
}

async function resolveStationForHouse(houseId: string) {
  const result = await pool.query(
    `SELECT c.legacy_station_id AS station_id
       FROM channels c
      WHERE c.house_id = $1
        AND c.status = 'active'
        AND c.legacy_station_id IS NOT NULL
      ORDER BY c.created_at ASC
      LIMIT 1`,
    [houseId],
  );

  return result.rows[0]?.station_id ?? null;
}

async function ensurePollBelongsToStation(pollId: string, stationId: string) {
  const result = await pool.query(
    `SELECT id
       FROM audience_polls
      WHERE id = $1
        AND station_id = $2
        AND status = 'active'
        AND (starts_at IS NULL OR starts_at <= now())
        AND (ends_at IS NULL OR ends_at > now())
      LIMIT 1`,
    [pollId, stationId],
  );

  return Boolean(result.rowCount);
}

async function ensurePollOptionBelongsToPoll(optionId: string, pollId: string) {
  const result = await pool.query(
    `SELECT id
       FROM audience_poll_options
      WHERE id = $1
        AND poll_id = $2
      LIMIT 1`,
    [optionId, pollId],
  );

  return Boolean(result.rowCount);
}

async function ensureMediaAssetBelongsToStation(assetId: string, stationId: string) {
  const result = await pool.query(
    `SELECT id
       FROM media_assets
      WHERE id = $1
        AND station_id = $2
      LIMIT 1`,
    [assetId, stationId],
  );

  return Boolean(result.rowCount);
}

const chatSchema = z
  .object({
    anonymousId: z.string().trim().min(8).max(128).optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
    body: z.string().trim().min(1).max(500),
  })
  .strict();

const presenceSchema = z
  .object({
    anonymousId: z.string().trim().min(8).max(128).optional(),
  })
  .strict();

const reactionSchema = z
  .object({
    anonymousId: z.string().trim().min(8).max(128).optional(),
    reaction: z.enum(["like", "love", "fire", "dance", "wow"]),
    mediaAssetId: z.string().uuid().optional(),
  })
  .strict();

const requestSchema = z
  .object({
    anonymousId: z.string().trim().min(8).max(128).optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
    mediaAssetId: z.string().uuid(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const dedicationSchema = z
  .object({
    anonymousId: z.string().trim().min(8).max(128).optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
    recipientName: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(500),
  })
  .strict();

const voteSchema = z
  .object({
    anonymousId: z.string().trim().min(8).max(128).optional(),
    optionId: z.string().uuid(),
  })
  .strict();

router.use(publicLimiter);

router.get("/:house/listener", async (req, res) => {
  try {
    const house = await listenerHouse(req, res);
    if (!house) return;

    const stationId = await resolveStationForHouse(house.id);

    const houseResult = await pool.query(
      `SELECT
          h.slug AS house_slug,
          h.name AS house_name,
          h.house_type,
          h.timezone,
          cr.handle AS creator_handle,
          cr.display_name AS creator_display_name,
          cr.bio AS creator_bio,
          cr.avatar_key AS creator_avatar_key,
          COALESCE(
            json_agg(
              json_build_object(
                'slug', c.slug,
                'name', c.name,
                'channel_type', c.channel_type,
                'status', c.status
              ) ORDER BY c.created_at
            ) FILTER (WHERE c.id IS NOT NULL),
            '[]'::json
          ) AS channels
       FROM houses h
       LEFT JOIN creators cr
         ON cr.house_id = h.id
       LEFT JOIN channels c
         ON c.house_id = h.id AND c.status = 'active'
      WHERE h.id = $1
      GROUP BY h.id, cr.id
      LIMIT 1`,
      [house.id],
    );

    const row = houseResult.rows[0];

    if (!row) {
      return res.status(404).json({ error: "HOUSE_NOT_FOUND" });
    }

    const nowPlaying = stationId ? await getNowPlaying(stationId) : null;

    res.json({
      house: publicHouseDto(row),
      nowPlaying: nowPlayingDto(nowPlaying),
    });
  } catch (error) {
    console.error("INN-008 listener house error", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

router.get("/:house/listener/now-playing", async (req, res) => {
  try {
    const house = await listenerHouse(req, res);
    if (!house) return;

    const stationId = await resolveStationForHouse(house.id);
    if (!stationId) {
      return res.status(404).json({ error: "CHANNEL_NOT_FOUND" });
    }

    const nowPlaying = await getNowPlaying(stationId);

    res.json({
      nowPlaying: nowPlayingDto(nowPlaying),
    });
  } catch (error) {
    console.error("INN-008 now-playing error", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

router.get("/:house/listener/chat", async (req, res) => {
  try {
    const house = await listenerHouse(req, res);
    if (!house) return;

    const stationId = await resolveStationForHouse(house.id);
    if (!stationId) {
      return res.status(404).json({ error: "CHANNEL_NOT_FOUND" });
    }

    const result = await pool.query(
      `SELECT id, display_name, body, created_at
         FROM audience_messages
        WHERE station_id = $1
          AND status = 'visible'
        ORDER BY created_at DESC
        LIMIT 100`,
      [stationId],
    );

    res.json({
      messages: result.rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        body: row.body,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error("INN-008 chat read error", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

router.post("/:house/listener/chat", async (req, res) => {
  try {
    const house = await listenerHouse(req, res);
    if (!house) return;

    const parsed = chatSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_REQUEST" });
    }

    const stationId = await resolveStationForHouse(house.id);
    if (!stationId) {
      return res.status(404).json({ error: "CHANNEL_NOT_FOUND" });
    }

    const actor = actorFromRequest(
      req,
      parsed.data.anonymousId,
      parsed.data.displayName,
    );

    const result = await pool.query(
      `INSERT INTO audience_messages
        (station_id, user_id, anonymous_id, display_name, body, status)
       VALUES ($1, $2, $3, $4, $5, 'visible')
       RETURNING id, display_name, body, created_at`,
      [
        stationId,
        actor.userId ?? null,
        actor.anonymousId ?? null,
        actor.displayName ?? "Listener",
        parsed.data.body,
      ],
    );

    const row = result.rows[0];

    res.status(201).json({
      message: {
        id: row.id,
        displayName: row.display_name,
        body: row.body,
        createdAt: row.created_at,
      },
      anonymousId: actor.anonymousId ?? null,
    });
  } catch (error) {
    console.error("INN-008 chat write error", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

router.get("/:house/listener/polls", async (req, res) => {
  try {
    const house = await listenerHouse(req, res);
    if (!house) return;

    const stationId = await resolveStationForHouse(house.id);
    if (!stationId) {
      return res.status(404).json({ error: "CHANNEL_NOT_FOUND" });
    }

    const result = await pool.query(
      `SELECT
          p.id,
          p.question,
          p.starts_at,
          p.ends_at,
          COALESCE(
            json_agg(
              json_build_object('id', o.id, 'label', o.label)
              ORDER BY o.position
            ) FILTER (WHERE o.id IS NOT NULL),
            '[]'::json
          ) AS options
       FROM audience_polls p
       LEFT JOIN audience_poll_options o ON o.poll_id = p.id
      WHERE p.station_id = $1
        AND p.status = 'active'
        AND (p.starts_at IS NULL OR p.starts_at <= now())
        AND (p.ends_at IS NULL OR p.ends_at > now())
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 20`,
      [stationId],
    );

    res.json({
      polls: result.rows.map((row) => ({
        id: row.id,
        question: row.question,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        options: row.options,
      })),
    });
  } catch (error) {
    console.error("INN-008 polls read error", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

router.post("/:house/listener/polls/:pollId/vote", async (req, res) => {
  try {
    const house = await listenerHouse(req, res);
    if (!house) return;

    const parsed = voteSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_REQUEST" });
    }

    const stationId = await resolveStationForHouse(house.id);
    if (!stationId) {
      return res.status(404).json({ error: "CHANNEL_NOT_FOUND" });
    }

    if (!(await ensurePollBelongsToStation(req.params.pollId, stationId))) {
      return res.status(404).json({ error: "POLL_NOT_FOUND" });
    }

    if (!(await ensurePollOptionBelongsToPoll(parsed.data.optionId, req.params.pollId))) {
      return res.status(400).json({ error: "OPTION_NOT_FOUND" });
    }

    if (!req.session?.userId && !parsed.data.anonymousId) {
      return res.status(400).json({ error: "ANONYMOUS_ID_REQUIRED" });
    }

    const actor = actorFromRequest(
      req,
      parsed.data.anonymousId,
    );

    const result = await pool.query(
      `INSERT INTO audience_poll_votes
        (poll_id, option_id, user_id, anonymous_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        req.params.pollId,
        parsed.data.optionId,
        actor.userId ?? null,
        actor.anonymousId ?? null,
      ],
    );

    res.status(result.rowCount ? 201 : 200).json({
      accepted: true,
      recorded: Boolean(result.rowCount),
    });
  } catch (error) {
    console.error("INN-008 poll vote error", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

router.post("/:house/listener/presence", async (req, res) => {
  try {
    const house = await listenerHouse(req, res);
    if (!house) return;

    const parsed = presenceSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_REQUEST" });
    }

    const stationId = await resolveStationForHouse(house.id);
    if (!stationId) {
      return res.status(404).json({ error: "CHANNEL_NOT_FOUND" });
    }

    const actor = actorFromRequest(req, parsed.data.anonymousId);

    await presenceHeartbeat(stationId, actor);

    res.status(204).send();
  } catch (error) {
    console.error("INN-008 presence error", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

router.post("/:house/listener/reactions", async (req, res) => {
  try {
    const house = await listenerHouse(req, res);
    if (!house) return;

    const parsed = reactionSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_REQUEST" });
    }

    const stationId = await resolveStationForHouse(house.id);
    if (!stationId) {
      return res.status(404).json({ error: "CHANNEL_NOT_FOUND" });
    }

    let mediaAssetId = parsed.data.mediaAssetId;

    if (mediaAssetId && !(await ensureMediaAssetBelongsToStation(mediaAssetId, stationId))) {
      return res.status(404).json({ error: "MEDIA_ASSET_NOT_FOUND" });
    }

    const actor = actorFromRequest(req, parsed.data.anonymousId);

    await react({
      stationId,
      actor,
      reaction: parsed.data.reaction,
      mediaAssetId,
    });

    res.status(204).send();
  } catch (error) {
    console.error("INN-008 reaction error", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

router.post("/:house/listener/requests", async (req, res) => {
  try {
    const house = await listenerHouse(req, res);
    if (!house) return;

    const parsed = requestSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_REQUEST" });
    }

    const stationId = await resolveStationForHouse(house.id);
    if (!stationId) {
      return res.status(404).json({ error: "CHANNEL_NOT_FOUND" });
    }

    if (!(await ensureMediaAssetBelongsToStation(parsed.data.mediaAssetId, stationId))) {
      return res.status(404).json({ error: "MEDIA_ASSET_NOT_FOUND" });
    }

    const actor = actorFromRequest(
      req,
      parsed.data.anonymousId,
      parsed.data.displayName,
    );

    const created = await createRequest({
      stationId,
      actor,
      mediaAssetId: parsed.data.mediaAssetId,
      message: parsed.data.note,
    });

    res.status(201).json({
      requestId: created.id,
      anonymousId: actor.anonymousId ?? null,
    });
  } catch (error) {
    console.error("INN-008 request error", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

router.post("/:house/listener/dedications", async (req, res) => {
  try {
    const house = await listenerHouse(req, res);
    if (!house) return;

    const parsed = dedicationSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_REQUEST" });
    }

    const stationId = await resolveStationForHouse(house.id);
    if (!stationId) {
      return res.status(404).json({ error: "CHANNEL_NOT_FOUND" });
    }

    const actor = actorFromRequest(
      req,
      parsed.data.anonymousId,
      parsed.data.displayName,
    );

    const created = await createDedication({
      stationId,
      actor,
      recipientName: parsed.data.recipientName,
      message: parsed.data.message,
    });

    res.status(201).json({
      dedicationId: created.id,
      anonymousId: actor.anonymousId ?? null,
    });
  } catch (error) {
    console.error("INN-008 dedication error", error);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

export default router;
