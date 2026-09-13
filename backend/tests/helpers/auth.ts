import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import request from "supertest";
import type { Express } from "express";
import { testPool } from "./db.js";

export interface TestUser {
  id: string;
  email: string;
  password: string;
  displayName: string;
  roles: string[];
}

export async function createTestUser(opts: {
  email?: string;
  password?: string;
  displayName?: string;
  roles?: string[];
  isActive?: boolean;
} = {}): Promise<TestUser> {
  const email = opts.email ?? `test-${randomUUID()}@example.test`;
  const password = opts.password ?? "CorrectHorseBatteryStaple9";
  const displayName = opts.displayName ?? "Test User";
  const roles = opts.roles ?? ["LISTENER"];
  const isActive = opts.isActive ?? true;

  const passwordHash = await bcrypt.hash(password, 4); // low cost factor - test speed only
  const userRes = await testPool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name, is_active) VALUES ($1,$2,$3,$4) RETURNING id`,
    [email, passwordHash, displayName, isActive]
  );
  const id = userRes.rows[0].id;

  for (const role of roles) {
    const roleRow = await testPool.query<{ id: number }>(`SELECT id FROM roles WHERE name = $1`, [role]);
    if (!roleRow.rows[0]) throw new Error(`Unknown role in test fixture: ${role}`);
    await testPool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, roleRow.rows[0].id]);
  }

  return { id, email, password, displayName, roles };
}

/** Logs in through the real /api/auth/login endpoint and returns an agent that persists the session cookie. */
export async function loginAgent(app: Express, email: string, password: string, forwardedFor = "10.10.10.10") {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").set("X-Forwarded-For", forwardedFor).send({ email, password });
  if (res.status !== 200) {
    throw new Error(`Test login failed unexpectedly: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return agent;
}
