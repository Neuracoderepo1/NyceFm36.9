import { pool } from "../db/pool.js";

export interface AuditEventInput {
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/**
 * Writes an immutable audit record. Never update or delete rows in
 * audit_events from application code — only INSERT.
 */
export async function recordAuditEvent(evt: AuditEventInput): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events
      (actor_id, action, resource_type, resource_id, before_state, after_state, ip_address, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      evt.actorId,
      evt.action,
      evt.resourceType,
      evt.resourceId ?? null,
      evt.beforeState ? JSON.stringify(evt.beforeState) : null,
      evt.afterState ? JSON.stringify(evt.afterState) : null,
      evt.ipAddress ?? null,
      evt.correlationId ?? null,
    ]
  );
}
