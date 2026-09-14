import { Router, type Request } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/rbac.js";

export const innhouseRouter = Router();

type HouseContext = {
  house: {
    id: string;
    slug: string;
    name: string;
    houseType: string;
    status: string;
    timezone: string | null;
    config: unknown;
  };
  creator: {
    id: string;
    handle: string;
    displayName: string;
    bio: string | null;
    avatarKey: string | null;
    metadata: unknown;
  } | null;
  channels: Array<{
    id: string;
    slug: string;
    name: string;
    channelType: string;
    status: string;
    legacyStationId: string | null;
    config: unknown;
  }>;
  membership: {
    role: string;
    status: string;
  };
};

async function resolveHouse(req: Request): Promise<HouseContext> {
  const houseKey = req.params.house;
  const userId = req.session.userId!;

  // Resolve the tenant first. Never resolve legacy records independently
  // from the requested House.
  const houseResult = await pool.query<{
    id: string;
    slug: string;
    name: string;
    house_type: string;
    status: string;
    timezone: string | null;
    config: unknown;
  }>(
    `SELECT id, slug, name, house_type, status, timezone, config
       FROM houses
      WHERE (id::text = $1 OR slug = $1)
      LIMIT 1`,
    [houseKey]
  );

  const house = houseResult.rows[0];
  if (!house || house.status !== "active") {
    const error = new Error("HOUSE_NOT_FOUND");
    (error as Error & { statusCode?: number }).statusCode = 404;
    throw error;
  }

  const membershipResult = await pool.query<{
    role: string;
    status: string;
  }>(
    `SELECT role, status
       FROM house_members
      WHERE house_id = $1
        AND user_id = $2
        AND status = 'active'
      LIMIT 1`,
    [house.id, userId]
  );

  const membership = membershipResult.rows[0];
  if (!membership) {
    const error = new Error("HOUSE_FORBIDDEN");
    (error as Error & { statusCode?: number }).statusCode = 403;
    throw error;
  }

  const [creatorResult, channelsResult] = await Promise.all([
    pool.query<{
      id: string;
      handle: string;
      display_name: string;
      bio: string | null;
      avatar_key: string | null;
      metadata: unknown;
    }>(
      `SELECT id, handle, display_name, bio, avatar_key, metadata
         FROM creators
        WHERE house_id = $1
        ORDER BY created_at ASC
        LIMIT 1`,
      [house.id]
    ),
    pool.query<{
      id: string;
      slug: string;
      name: string;
      channel_type: string;
      status: string;
      legacy_station_id: string | null;
      config: unknown;
    }>(
      `SELECT id, slug, name, channel_type, status, legacy_station_id, config
         FROM channels
        WHERE house_id = $1
        ORDER BY created_at ASC`,
      [house.id]
    ),
  ]);

  return {
    house: {
      id: house.id,
      slug: house.slug,
      name: house.name,
      houseType: house.house_type,
      status: house.status,
      timezone: house.timezone,
      config: house.config,
    },
    creator: creatorResult.rows[0]
      ? {
          id: creatorResult.rows[0].id,
          handle: creatorResult.rows[0].handle,
          displayName: creatorResult.rows[0].display_name,
          bio: creatorResult.rows[0].bio,
          avatarKey: creatorResult.rows[0].avatar_key,
          metadata: creatorResult.rows[0].metadata,
        }
      : null,
    channels: channelsResult.rows.map((channel) => ({
      id: channel.id,
      slug: channel.slug,
      name: channel.name,
      channelType: channel.channel_type,
      status: channel.status,
      legacyStationId: channel.legacy_station_id,
      config: channel.config,
    })),
    membership: {
      role: membership.role,
      status: membership.status,
    },
  };
}

function platformModule(module: string, context: HouseContext) {
  return {
    house: context.house,
    module,
    status: "ready" as const,
    legacy: {
      stationId:
        context.channels.find((channel) => channel.legacyStationId)?.legacyStationId ?? null,
    },
  };
}

function houseErrorResponse(req: Request, res: any, err: unknown) {
  const statusCode =
    err instanceof Error && typeof (err as Error & { statusCode?: number }).statusCode === "number"
      ? (err as Error & { statusCode?: number }).statusCode!
      : 500;

  if (statusCode === 404) {
    return res.status(404).json({
      error: {
        code: "HOUSE_NOT_FOUND",
        message: "House not found.",
        request_id: req.id,
      },
    });
  }

  if (statusCode === 403) {
    return res.status(403).json({
      error: {
        code: "HOUSE_FORBIDDEN",
        message: "You are not a member of this House.",
        request_id: req.id,
      },
    });
  }

  throw err;
}

// ---------------------------------------------------------------------
// Public House presentation endpoint
//
// GET /api/houses/:house/public is intentionally unauthenticated and
// intentionally narrow. It exists for public-facing surfaces (station
// website, embeds, share cards) that need House/creator/channel display
// data without a logged-in session.
//
// It must NEVER return:
//   - house_members rows, roles, or membership status
//   - legacy_station_id (an internal linkage to the pre-INNHOUSE schema)
//   - raw `config` JSONB blobs (may hold non-presentation / internal
//     settings that were never vetted for public exposure)
//   - internal UUIDs (slugs are the public-facing identifiers)
//   - non-active channels (paused/archived channels aren't public)
//
// This is a distinct resolver (not a "redacted" reuse of resolveHouse())
// on purpose: a resolver built for an authenticated, membership-checked
// context is the wrong place to grow a public code path from, since any
// future field added to that context is auth-gated by construction, not
// by someone remembering to filter it back out here.
// ---------------------------------------------------------------------

type PublicHouseContext = {
  house: {
    slug: string;
    name: string;
    houseType: string;
    timezone: string | null;
  };
  creator: {
    handle: string;
    displayName: string;
    bio: string | null;
    avatarKey: string | null;
  } | null;
  channels: Array<{
    slug: string;
    name: string;
    channelType: string;
  }>;
};

async function resolvePublicHouse(req: Request): Promise<PublicHouseContext> {
  const houseKey = req.params.house;

  // id used only to join creators/channels below; never included in the
  // response body itself.
  const houseResult = await pool.query<{
    id: string;
    slug: string;
    name: string;
    house_type: string;
    status: string;
    timezone: string | null;
  }>(
    `SELECT id, slug, name, house_type, status, timezone
       FROM houses
      WHERE (id::text = $1 OR slug = $1)
      LIMIT 1`,
    [houseKey]
  );

  const house = houseResult.rows[0];
  if (!house || house.status !== "active") {
    const error = new Error("HOUSE_NOT_FOUND");
    (error as Error & { statusCode?: number }).statusCode = 404;
    throw error;
  }

  const [creatorResult, channelsResult] = await Promise.all([
    pool.query<{
      handle: string;
      display_name: string;
      bio: string | null;
      avatar_key: string | null;
    }>(
      `SELECT handle, display_name, bio, avatar_key
         FROM creators
        WHERE house_id = $1
        ORDER BY created_at ASC
        LIMIT 1`,
      [house.id]
    ),
    pool.query<{
      slug: string;
      name: string;
      channel_type: string;
    }>(
      `SELECT slug, name, channel_type
         FROM channels
        WHERE house_id = $1
          AND status = 'active'
        ORDER BY created_at ASC`,
      [house.id]
    ),
  ]);

  return {
    house: {
      slug: house.slug,
      name: house.name,
      houseType: house.house_type,
      timezone: house.timezone,
    },
    creator: creatorResult.rows[0]
      ? {
          handle: creatorResult.rows[0].handle,
          displayName: creatorResult.rows[0].display_name,
          bio: creatorResult.rows[0].bio,
          avatarKey: creatorResult.rows[0].avatar_key,
        }
      : null,
    channels: channelsResult.rows.map((channel) => ({
      slug: channel.slug,
      name: channel.name,
      channelType: channel.channel_type,
    })),
  };
}

// Registered ahead of `innhouseRouter.use(requireAuth)` below so this
// path is never gated behind a session — that ordering is the actual
// enforcement mechanism, not a comment's promise.
innhouseRouter.get("/:house/public", async (req, res) => {
  try {
    const context = await resolvePublicHouse(req);
    res.set("Cache-Control", "public, max-age=30");
    res.json(context);
  } catch (err) {
    return houseErrorResponse(req, res, err);
  }
});

innhouseRouter.use(requireAuth);

innhouseRouter.get("/:house", async (req, res) => {
  try {
    const context = await resolveHouse(req);
    res.json(context);
  } catch (err) {
    return houseErrorResponse(req, res, err);
  }
});

const modules = [
  "audience",
  "content",
  "engagement",
  "broadcast",
  "analytics",
  "intelligence",
  "monetization",
] as const;

for (const module of modules) {
  innhouseRouter.get(`/:house/${module}`, async (req, res) => {
    try {
      const context = await resolveHouse(req);
      res.json(platformModule(module, context));
    } catch (err) {
      return houseErrorResponse(req, res, err);
    }
  });
}
