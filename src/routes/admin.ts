import { Router } from "express";
import { pool } from "../db/pool.js";
import { requirePermission } from "../middleware/rbac.js";
import { recordAuditEvent } from "../services/audit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const adminRouter = Router();

// Every route below requires a server-verified permission looked up from
// role_permissions — never a client-supplied `isAdmin` flag.

adminRouter.get("/users", requirePermission("users.manage"), asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.is_active, u.created_at,
            COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     GROUP BY u.id
     ORDER BY u.created_at DESC
     LIMIT 200`
  );
  res.json({ users: rows });
}));

adminRouter.get("/audit", requirePermission("audit.read"), asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, actor_id, action, resource_type, resource_id, created_at
     FROM audit_events ORDER BY created_at DESC LIMIT 100`
  );
  res.json({ events: rows });
}));

adminRouter.post("/users/:userId/roles/:roleName", requirePermission("users.manage"), asyncHandler(async (req, res) => {
  const { userId, roleName } = req.params;
  const roleRes = await pool.query("SELECT id FROM roles WHERE name = $1", [roleName]);
  if (roleRes.rowCount === 0) {
    return res.status(404).json({ error: { code: "ROLE_NOT_FOUND", message: "Unknown role.", request_id: req.id } });
  }
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id, granted_by) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    [userId, roleRes.rows[0].id, req.session.userId]
  );
  await recordAuditEvent({
    actorId: req.session.userId ?? null,
    action: "ROLE_GRANTED",
    resourceType: "user",
    resourceId: userId,
    afterState: { role: roleName },
    correlationId: req.id,
  });
  res.status(204).send();
}));
