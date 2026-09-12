import type { NextFunction, Request, Response } from "express";
import { getUserPermissions } from "../services/auth.js";

/**
 * Requires an authenticated session. The session is server-side
 * (Redis-backed), so this cannot be forged from the browser the way
 * localStorage-based "auth" could be.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "Login required.", request_id: req.id },
    });
  }
  next();
}

/**
 * Requires one specific server-verified permission. Permissions are
 * looked up fresh from role_permissions on each request rather than
 * trusted from a client-supplied flag like `isAdmin`.
 */
export function requirePermission(permissionCode: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.userId) {
      return res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Login required.", request_id: req.id },
      });
    }
    const permissions = await getUserPermissions(req.session.userId);
    if (!permissions.includes(permissionCode)) {
      return res.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: `Missing required permission: ${permissionCode}`,
          request_id: req.id,
        },
      });
    }
    next();
  };
}
