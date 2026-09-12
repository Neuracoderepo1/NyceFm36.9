import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { recordAuditEvent } from "./audit.js";

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
}

export class AuthError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

export async function registerUser(
  email: string,
  password: string,
  displayName: string
): Promise<PublicUser> {
  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rowCount) {
    throw new AuthError("An account with this email already exists.", "EMAIL_TAKEN");
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userRes = await client.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1,$2,$3) RETURNING id, email, display_name`,
      [email, passwordHash, displayName]
    );
    const user = userRes.rows[0];

    const roleRes = await client.query("SELECT id FROM roles WHERE name = 'LISTENER'");
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)",
      [user.id, roleRes.rows[0].id]
    );
    await client.query("COMMIT");

    await recordAuditEvent({
      actorId: user.id,
      action: "USER_REGISTERED",
      resourceType: "user",
      resourceId: user.id,
    });

    return { id: user.id, email: user.email, displayName: user.display_name, roles: ["LISTENER"] };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function authenticate(
  email: string,
  password: string,
  ipAddress: string | null
): Promise<PublicUser> {
  const res = await pool.query(
    `SELECT id, email, password_hash, display_name, is_active, failed_login_count, locked_until
     FROM users WHERE email = $1`,
    [email]
  );

  const logAttempt = (success: boolean) =>
    pool.query(
      "INSERT INTO login_attempts (email, ip_address, success) VALUES ($1,$2,$3)",
      [email, ipAddress, success]
    );

  if (res.rowCount === 0) {
    await logAttempt(false);
    throw new AuthError("Invalid email or password.", "INVALID_CREDENTIALS");
  }

  const user = res.rows[0];

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await logAttempt(false);
    throw new AuthError(
      `Account temporarily locked. Try again after ${new Date(user.locked_until).toISOString()}.`,
      "ACCOUNT_LOCKED"
    );
  }

  if (!user.is_active) {
    await logAttempt(false);
    throw new AuthError("Account is disabled.", "ACCOUNT_DISABLED");
  }

  const valid = await bcrypt.compare(password, user.password_hash);

  if (!valid) {
    const failedCount = user.failed_login_count + 1;
    const lockUntil =
      failedCount >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
        : null;
    await pool.query(
      "UPDATE users SET failed_login_count = $1, locked_until = $2, updated_at = now() WHERE id = $3",
      [failedCount, lockUntil, user.id]
    );
    await logAttempt(false);
    if (lockUntil) {
      await recordAuditEvent({
        actorId: user.id,
        action: "ACCOUNT_LOCKED",
        resourceType: "user",
        resourceId: user.id,
        afterState: { locked_until: lockUntil },
      });
    }
    throw new AuthError("Invalid email or password.", "INVALID_CREDENTIALS");
  }

  await pool.query(
    "UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1",
    [user.id]
  );
  await logAttempt(true);

  const roles = await getUserRoles(user.id);

  await recordAuditEvent({
    actorId: user.id,
    action: "USER_LOGIN",
    resourceType: "user",
    resourceId: user.id,
    ipAddress,
  });

  return { id: user.id, email: user.email, displayName: user.display_name, roles };
}

export async function getUserRoles(userId: string): Promise<string[]> {
  const res = await pool.query(
    `SELECT r.name FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1`,
    [userId]
  );
  return res.rows.map((r) => r.name);
}

export async function getUserPermissions(userId: string): Promise<string[]> {
  const res = await pool.query(
    `SELECT DISTINCT p.code FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1`,
    [userId]
  );
  return res.rows.map((r) => r.code);
}
