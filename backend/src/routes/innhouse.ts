import { Router, type Request } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/rbac.js";
import {
  attachHouseAuth,
  requireHouseRole,
  resolveActiveHouse,
  isPlatformSuperAdmin,
  sendHouseError,
  type HouseRole,
} from "../middleware/houseAuth.js";

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

// =======================================================================
// INN-007 · Secure House & Creator onboarding
//
// Everything below is a second, independent tenancy boundary from
// resolveHouse() above: attachHouseAuth()/requireHouseRole() (see
// ../middleware/houseAuth.ts) resolve only { houseId, houseSlug, role }
// -- no creator/channel payload -- since these routes only need to
// authorize a mutation, not render a House detail page.
//
// Invariant enforced throughout: the House comes from the resolved route
// context (req.houseAuth.houseId), the actor comes from the server-side
// session (req.session.userId), and the House ROLE comes only from the
// house_members row just resolved. None of the three is ever read from
// the request body. Every INSERT/UPDATE/DELETE below is additionally
// scoped by house_id in its WHERE clause, even where req.houseAuth.houseId
// already guarantees correctness -- defense in depth against a future
// refactor accidentally dropping that guarantee upstream.
// =======================================================================

const memberRoleInput = z.enum(["admin", "member"]); // 'owner' is never settable here -- see PART XV
const houseMemberRow = (r: {
  user_id: string;
  role: HouseRole;
  status: string;
  created_at: Date;
  email: string;
  display_name: string;
}) => ({
  userId: r.user_id,
  role: r.role,
  status: r.status,
  createdAt: r.created_at,
  email: r.email,
  displayName: r.display_name,
});

innhouseRouter.get("/:house/members", attachHouseAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT hm.user_id, hm.role, hm.status, hm.created_at, u.email, u.display_name
       FROM house_members hm
       JOIN users u ON u.id = hm.user_id
      WHERE hm.house_id = $1
      ORDER BY hm.created_at ASC`,
    [req.houseAuth!.houseId]
  );
  res.json({ members: result.rows.map(houseMemberRow) });
});

innhouseRouter.post(
  "/:house/members",
  attachHouseAuth,
  requireHouseRole("owner", "admin"),
  async (req, res) => {
    const body = z.object({ email: z.string().email(), role: memberRoleInput.default("member") }).parse(req.body ?? {});
    const houseId = req.houseAuth!.houseId;

    const userResult = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [body.email]);
    const targetUser = userResult.rows[0];
    if (!targetUser) {
      return sendHouseError(req, res, 404, "USER_NOT_FOUND", "No platform user exists with that email.");
    }

    // No parallel invitation/token infrastructure exists in this
    // repository (checked: no invite tables, tokens, or email flows) --
    // per PART XXIII this is the minimum secure mechanism: an existing
    // platform user is added in 'invited' status and must accept via
    // POST /:house/members/accept before they hold any House authority.
    // Being invited never itself grants administrative capability --
    // every House-role check below reads status = 'active'.
    const insertResult = await pool.query(
      `INSERT INTO house_members (house_id, user_id, role, status)
       VALUES ($1, $2, $3, 'invited')
       ON CONFLICT (house_id, user_id) DO NOTHING
       RETURNING user_id, role, status, created_at`,
      [houseId, targetUser.id, body.role]
    );
    if (insertResult.rowCount === 0) {
      return sendHouseError(req, res, 409, "ALREADY_A_MEMBER", "This user already has a membership record for this House.");
    }
    res.status(201).json({
      member: { ...insertResult.rows[0], email: body.email },
    });
  }
);

innhouseRouter.post("/:house/members/accept", async (req, res) => {
  // Cannot use attachHouseAuth here: it requires an already-ACTIVE
  // membership, but the entire point of this route is a caller whose
  // membership is still 'invited'. Resolve the House independently instead.
  const house = await resolveActiveHouse(req.params.house);
  if (!house) {
    return sendHouseError(req, res, 404, "HOUSE_NOT_FOUND", "House not found.");
  }
  const userId = req.session.userId!;
  const result = await pool.query(
    `UPDATE house_members SET status = 'active', updated_at = now()
      WHERE house_id = $1 AND user_id = $2 AND status = 'invited'
      RETURNING user_id, role, status`,
    [house.id, userId]
  );
  if (result.rowCount === 0) {
    return sendHouseError(req, res, 404, "NO_PENDING_INVITATION", "You have no pending invitation to this House.");
  }
  res.json({ member: result.rows[0] });
});

innhouseRouter.patch(
  "/:house/members/:userId",
  attachHouseAuth,
  requireHouseRole("owner", "admin"),
  async (req, res) => {
    const body = z
      .object({ role: memberRoleInput.optional(), status: z.enum(["active", "suspended", "removed"]).optional() })
      .refine((b) => b.role !== undefined || b.status !== undefined, { message: "role or status is required" })
      .parse(req.body ?? {});
    const houseId = req.houseAuth!.houseId;
    const targetUserId = req.params.userId;

    // Ownership can only change hands through POST /ownership/transfer
    // (PART XV) -- so a target currently holding 'owner' is entirely
    // off-limits to this generic endpoint, and 'owner' is never an
    // accepted value for `role` above (memberRoleInput excludes it). This
    // is what makes "final owner cannot be demoted/removed here" true by
    // construction rather than by a runtime count check.
    const currentResult = await pool.query<{ role: HouseRole }>(
      `SELECT role FROM house_members WHERE house_id = $1 AND user_id = $2`,
      [houseId, targetUserId]
    );
    const current = currentResult.rows[0];
    if (!current) {
      return sendHouseError(req, res, 404, "MEMBER_NOT_FOUND", "No such member in this House.");
    }
    if (current.role === "owner") {
      return sendHouseError(
        req,
        res,
        409,
        "OWNER_REQUIRES_TRANSFER",
        "The House owner's role or status cannot be changed here; use POST /ownership/transfer."
      );
    }
    if (req.houseAuth!.role === "admin" && (targetUserId === req.session.userId)) {
      // Not an explicitly listed rule, but consistent with "admin cannot
      // self-promote": an admin editing their own row (e.g. self-demoting
      // then re-promoting, or self-suspending to dodge an owner's review)
      // is exactly the kind of self-authorization path this boundary
      // exists to close off.
      return sendHouseError(req, res, 403, "CANNOT_MODIFY_SELF", "You cannot modify your own membership.");
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (body.role) {
      values.push(body.role);
      sets.push(`role = $${values.length}`);
    }
    if (body.status) {
      values.push(body.status);
      sets.push(`status = $${values.length}`);
    }
    values.push(houseId, targetUserId);
    const result = await pool.query(
      `UPDATE house_members SET ${sets.join(", ")}, updated_at = now()
        WHERE house_id = $${values.length - 1} AND user_id = $${values.length}
        RETURNING user_id, role, status`,
      values
    );
    res.json({ member: result.rows[0] });
  }
);

innhouseRouter.delete(
  "/:house/members/:userId",
  attachHouseAuth,
  requireHouseRole("owner", "admin"),
  async (req, res) => {
    const houseId = req.houseAuth!.houseId;
    const targetUserId = req.params.userId;

    const currentResult = await pool.query<{ role: HouseRole }>(
      `SELECT role FROM house_members WHERE house_id = $1 AND user_id = $2`,
      [houseId, targetUserId]
    );
    const current = currentResult.rows[0];
    if (!current) {
      return sendHouseError(req, res, 404, "MEMBER_NOT_FOUND", "No such member in this House.");
    }
    if (current.role === "owner") {
      return sendHouseError(
        req,
        res,
        409,
        "OWNER_REQUIRES_TRANSFER",
        "The House owner cannot be removed; transfer ownership first."
      );
    }

    await pool.query(
      `UPDATE house_members SET status = 'removed', updated_at = now() WHERE house_id = $1 AND user_id = $2`,
      [houseId, targetUserId]
    );
    res.status(204).end();
  }
);

// -----------------------------------------------------------------------
// Ownership transfer & ownerless-House bootstrap
//
// Both use pg_advisory_xact_lock(hashtext(house_id)) to serialize
// concurrent ownership operations on the SAME House -- a transaction-
// scoped lock that's automatically released on COMMIT/ROLLBACK, requires
// no new schema, and cannot deadlock across Houses since the lock key is
// per-house. Both re-verify the precondition (actor is still owner /
// House still has zero owners) *inside* the lock, not just via the
// middleware check that ran before the transaction opened -- closing the
// TOCTOU gap between "checked role" and "used role".
// -----------------------------------------------------------------------

innhouseRouter.post(
  "/:house/ownership/transfer",
  attachHouseAuth,
  requireHouseRole("owner"),
  async (req, res) => {
    const body = z.object({ targetUserId: z.string().uuid() }).parse(req.body ?? {});
    const houseId = req.houseAuth!.houseId;
    const actorId = req.session.userId!;

    if (body.targetUserId === actorId) {
      return sendHouseError(req, res, 400, "INVALID_TRANSFER_TARGET", "Cannot transfer ownership to yourself.");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [houseId]);

      const actorRow = await client.query<{ role: HouseRole; status: string }>(
        `SELECT role, status FROM house_members WHERE house_id = $1 AND user_id = $2 FOR UPDATE`,
        [houseId, actorId]
      );
      if (actorRow.rows[0]?.role !== "owner" || actorRow.rows[0]?.status !== "active") {
        await client.query("ROLLBACK");
        // Someone else raced this actor out of ownership between the
        // middleware check and this transaction acquiring the lock.
        return sendHouseError(req, res, 409, "OWNER_STATE_CHANGED", "You are no longer the active owner of this House.");
      }

      const targetRow = await client.query<{ status: string }>(
        `SELECT status FROM house_members WHERE house_id = $1 AND user_id = $2 FOR UPDATE`,
        [houseId, body.targetUserId]
      );
      if (!targetRow.rows[0]) {
        await client.query("ROLLBACK");
        return sendHouseError(req, res, 404, "TARGET_NOT_A_MEMBER", "Transfer target is not a member of this House.");
      }
      if (targetRow.rows[0].status !== "active") {
        await client.query("ROLLBACK");
        return sendHouseError(
          req,
          res,
          409,
          "TARGET_NOT_ACTIVE",
          `Transfer target's membership status is '${targetRow.rows[0].status}', not 'active'.`
        );
      }

      // Exactly one owner is demoted and exactly one is promoted in the
      // same transaction, so a zero-owner state is structurally
      // unreachable from this code path -- there is no window where the
      // count could be read as zero by a concurrent request.
      await client.query(
        `UPDATE house_members SET role = 'owner', updated_at = now() WHERE house_id = $1 AND user_id = $2`,
        [houseId, body.targetUserId]
      );
      await client.query(
        `UPDATE house_members SET role = 'admin', updated_at = now() WHERE house_id = $1 AND user_id = $2`,
        [houseId, actorId]
      );
      await client.query("COMMIT");
      res.json({ houseId, previousOwnerId: actorId, newOwnerId: body.targetUserId });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
);

innhouseRouter.post("/:house/ownership/bootstrap", async (req, res) => {
  // Cannot use attachHouseAuth here: the entire premise of this route is
  // that the caller may have NO House membership row at all (an ownerless
  // House, by definition, has nobody who could pass a House-role check).
  // Authorization instead comes from the platform SUPER_ADMIN check below
  // -- see PART XVII. This is intentionally the one exception to
  // "authorization comes from house_members", and it is narrowed as
  // tightly as the spec allows: self-only (no targetUserId, no assigning
  // some other arbitrary user), and only when the House currently has
  // zero active owners.
  const house = await resolveActiveHouse(req.params.house);
  if (!house) {
    return sendHouseError(req, res, 404, "HOUSE_NOT_FOUND", "House not found.");
  }
  const houseId = house.id;
  const actorId = req.session.userId!;

  if (!(await isPlatformSuperAdmin(actorId))) {
    return sendHouseError(
      req,
      res,
      403,
      "PLATFORM_SUPER_ADMIN_REQUIRED",
      "Bootstrapping an ownerless House requires the platform SUPER_ADMIN role."
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [houseId]);

    const ownerRows = await client.query(
      `SELECT user_id FROM house_members WHERE house_id = $1 AND role = 'owner' AND status = 'active' FOR UPDATE`,
      [houseId]
    );
    if (ownerRows.rowCount! > 0) {
      await client.query("ROLLBACK");
      return sendHouseError(req, res, 409, "HOUSE_ALREADY_HAS_OWNER", "This House already has an active owner.");
    }

    await client.query(
      `INSERT INTO house_members (house_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')
       ON CONFLICT (house_id, user_id) DO UPDATE SET role = 'owner', status = 'active', updated_at = now()`,
      [houseId, actorId]
    );
    await client.query("COMMIT");
    res.status(201).json({ houseId, ownerId: actorId });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// -----------------------------------------------------------------------
// Creator management (PART XX-XXII)
// -----------------------------------------------------------------------

const creatorRow = (r: {
  id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  avatar_key: string | null;
  metadata: unknown;
}) => ({
  id: r.id,
  handle: r.handle,
  displayName: r.display_name,
  bio: r.bio,
  avatarKey: r.avatar_key,
  metadata: r.metadata,
});

innhouseRouter.get("/:house/creators", attachHouseAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, handle, display_name, bio, avatar_key, metadata
       FROM creators WHERE house_id = $1 ORDER BY created_at ASC`,
    [req.houseAuth!.houseId]
  );
  res.json({ creators: result.rows.map(creatorRow) });
});

const creatorHandle = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "handle must be lowercase letters, numbers, '_' or '-'");

innhouseRouter.post(
  "/:house/creators",
  attachHouseAuth,
  requireHouseRole("owner", "admin"),
  async (req, res) => {
    const body = z
      .object({
        handle: creatorHandle,
        displayName: z.string().trim().min(1).max(120),
        bio: z.string().max(2000).optional(),
        avatarKey: z.string().max(500).optional(),
        metadata: z.record(z.unknown()).optional(),
      })
      .parse(req.body ?? {});

    try {
      const result = await pool.query(
        `INSERT INTO creators (house_id, handle, display_name, bio, avatar_key, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, handle, display_name, bio, avatar_key, metadata`,
        [
          req.houseAuth!.houseId,
          body.handle,
          body.displayName,
          body.bio ?? null,
          body.avatarKey ?? null,
          JSON.stringify(body.metadata ?? {}),
        ]
      );
      res.status(201).json({ creator: creatorRow(result.rows[0]) });
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "23505") {
        return sendHouseError(req, res, 409, "CREATOR_HANDLE_TAKEN", `Handle '${body.handle}' is already in use in this House.`);
      }
      throw err;
    }
  }
);

innhouseRouter.patch(
  "/:house/creators/:creatorId",
  attachHouseAuth,
  requireHouseRole("owner", "admin"),
  async (req, res) => {
    const body = z
      .object({
        handle: creatorHandle.optional(),
        displayName: z.string().trim().min(1).max(120).optional(),
        bio: z.string().max(2000).nullable().optional(),
        avatarKey: z.string().max(500).nullable().optional(),
        metadata: z.record(z.unknown()).optional(),
      })
      .parse(req.body ?? {});

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, val: unknown) => {
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };
    if (body.handle !== undefined) push("handle", body.handle);
    if (body.displayName !== undefined) push("display_name", body.displayName);
    if (body.bio !== undefined) push("bio", body.bio);
    if (body.avatarKey !== undefined) push("avatar_key", body.avatarKey);
    if (body.metadata !== undefined) push("metadata", JSON.stringify(body.metadata));
    if (sets.length === 0) {
      return sendHouseError(req, res, 400, "NO_FIELDS_TO_UPDATE", "At least one field must be provided.");
    }

    values.push(req.houseAuth!.houseId, req.params.creatorId);
    try {
      // Scoped by house_id in the same WHERE clause as the id, so a
      // creatorId belonging to a different House matches zero rows here
      // -- it can never be distinguished from "creator does not exist",
      // which is exactly the point: cross-House existence isn't leaked.
      const result = await pool.query(
        `UPDATE creators SET ${sets.join(", ")}, updated_at = now()
          WHERE house_id = $${values.length - 1} AND id = $${values.length}
          RETURNING id, handle, display_name, bio, avatar_key, metadata`,
        values
      );
      if (result.rowCount === 0) {
        return sendHouseError(req, res, 404, "CREATOR_NOT_FOUND", "No such creator in this House.");
      }
      res.json({ creator: creatorRow(result.rows[0]) });
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "23505") {
        return sendHouseError(req, res, 409, "CREATOR_HANDLE_TAKEN", `Handle '${body.handle}' is already in use in this House.`);
      }
      throw err;
    }
  }
);

innhouseRouter.delete(
  "/:house/creators/:creatorId",
  attachHouseAuth,
  requireHouseRole("owner", "admin"),
  async (req, res) => {
    const houseId = req.houseAuth!.houseId;
    const creatorId = req.params.creatorId;

    // Same house_id-scoped WHERE clause as the PATCH route above: a
    // creatorId belonging to a different House matches zero rows and is
    // indistinguishable from "creator does not exist" -- no cross-House
    // existence leak. Deleting the House's only creator is a valid state
    // (resolveHouse/resolvePublicHouse already treat `creator: null` as
    // normal -- a House was never required to have one), so no additional
    // "last creator" invariant is enforced here, unlike ownership.
    const result = await pool.query(
      `DELETE FROM creators WHERE house_id = $1 AND id = $2`,
      [houseId, creatorId]
    );
    if (result.rowCount === 0) {
      return sendHouseError(req, res, 404, "CREATOR_NOT_FOUND", "No such creator in this House.");
    }
    res.status(204).end();
  }
);
