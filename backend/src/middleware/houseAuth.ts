import type { NextFunction, Request, Response } from "express";
import { pool } from "../db/pool.js";

export type HouseRole = "owner" | "admin" | "member";

export interface HouseAuthContext {
  houseId: string;
  houseSlug: string;
  role: HouseRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      houseAuth?: HouseAuthContext;
    }
  }
}

export function sendHouseError(
  req: Request,
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>
) {
  return res.status(statusCode).json({ error: { code, message, request_id: req.id, ...extra } });
}

/**
 * Resolves an active House by id or slug, independent of any caller
 * membership. Shared by attachHouseAuth (which additionally requires
 * active membership) and by the two routes that must work for a caller
 * who is NOT yet an active member: accepting an invitation, and
 * bootstrapping an ownerless House.
 */
export async function resolveActiveHouse(houseKey: string): Promise<{ id: string; slug: string } | null> {
  const result = await pool.query<{ id: string; slug: string; status: string }>(
    `SELECT id, slug, status FROM houses WHERE (id::text = $1 OR slug = $1) LIMIT 1`,
    [houseKey]
  );
  const house = result.rows[0];
  if (!house || house.status !== "active") return null;
  return { id: house.id, slug: house.slug };
}

/**
 * Resolves the House from the route param and the caller's active
 * membership in it, attaching { houseId, houseSlug, role } to req.houseAuth.
 *
 * This is deliberately a separate resolver from innhouse.ts's resolveHouse()
 * -- that one additionally loads creator/channel data for the authenticated
 * House-detail response, and INN-007's mutation routes have no need for
 * that extra work on every request. Keeping them separate also means a
 * change to one can never accidentally alter the other's tenancy
 * boundary -- the two boundaries are each fully self-contained.
 *
 * Must run after requireAuth (reads req.session.userId). Requires ACTIVE
 * membership -- routes that must work for a non-member (accept, bootstrap)
 * use resolveActiveHouse() directly instead, never this function.
 */
export async function attachHouseAuth(req: Request, res: Response, next: NextFunction) {
  const houseKey = req.params.house;
  const userId = req.session.userId!;

  const house = await resolveActiveHouse(houseKey);
  if (!house) {
    return sendHouseError(req, res, 404, "HOUSE_NOT_FOUND", "House not found.");
  }

  const memberResult = await pool.query<{ role: HouseRole }>(
    `SELECT role FROM house_members WHERE house_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [house.id, userId]
  );
  const membership = memberResult.rows[0];
  if (!membership) {
    return sendHouseError(req, res, 403, "HOUSE_FORBIDDEN", "You are not a member of this House.");
  }

  req.houseAuth = { houseId: house.id, houseSlug: house.slug, role: membership.role };
  next();
}

/**
 * Requires the caller's House role (from attachHouseAuth) to be one of
 * `roles`. A platform role (LISTENER..SUPER_ADMIN) never substitutes for a
 * House role here -- PLATFORM RBAC and HOUSE RBAC are intentionally
 * separate axes; see PLATFORM_ROLE_IS_NOT_HOUSE_ROLE test coverage.
 */
export function requireHouseRole(...roles: HouseRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.houseAuth) {
      return sendHouseError(req, res, 500, "HOUSE_CONTEXT_MISSING", "House context was not resolved.");
    }
    if (!roles.includes(req.houseAuth.role)) {
      return sendHouseError(
        req,
        res,
        403,
        "HOUSE_ROLE_FORBIDDEN",
        `This action requires House role: ${roles.join(" or ")}.`
      );
    }
    next();
  };
}

/**
 * True if the given platform user currently holds the SUPER_ADMIN
 * platform role. Used only for the ownerless-House bootstrap path
 * (PART XVII), which is intentionally the single, narrow, self-bootstrap
 * exception to "House role comes only from house_members" -- it exists
 * precisely because a truly ownerless House has no house_members row for
 * anyone to check a House role against yet.
 */
export async function isPlatformSuperAdmin(userId: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND r.name = 'SUPER_ADMIN'
     ) AS exists`,
    [userId]
  );
  return result.rows[0]?.exists ?? false;
}
