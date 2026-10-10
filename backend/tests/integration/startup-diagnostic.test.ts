import { afterAll, describe, expect, it, vi } from "vitest";
import { testPool, closeTestPool } from "../helpers/db.js";
import { getTestDatabaseUrl } from "../helpers/env.js";
import {
  collectDbRoleDiagnostic,
  logDbRoleDiagnostic,
  DIAGNOSTIC_TABLES,
} from "../../src/db/startupDiagnostic.js";

describe("startup DB role diagnostic", () => {
  afterAll(async () => {
    await closeTestPool();
  });

  it("reports the effective role, its RLS-bypass flags and per-table privileges", async () => {
    const report = await collectDbRoleDiagnostic(testPool);

    expect(typeof report.effective_role).toBe("string");
    expect(report.effective_role.length).toBeGreaterThan(0);
    expect(typeof report.rolsuper).toBe("boolean");
    expect(typeof report.rolbypassrls).toBe("boolean");
    expect(report.rls_enforced_for_connection).toBe(!report.rolsuper && !report.rolbypassrls);
    expect(report.tables.map((t) => t.table)).toEqual([...DIAGNOSTIC_TABLES]);

    const houses = report.tables.find((t) => t.table === "houses")!;
    expect(houses.present).toBe(true);
    expect(houses.rls_enabled).toBe(true);
    for (const key of ["select", "insert", "update", "delete"] as const) {
      expect(typeof houses[key]).toBe("boolean");
    }
  });

  it("reports absent tables as present=false with null privileges instead of failing", async () => {
    const report = await collectDbRoleDiagnostic({
      query: (async (text: string, params?: unknown[]) =>
        testPool.query(text, text.includes("unnest") ? [["houses", "no_such_table_xyz"]] : params)) as never,
    });
    const missing = report.tables.find((t) => t.table === "no_such_table_xyz")!;
    expect(missing).toMatchObject({ present: false, select: null, insert: null, update: null, delete: null });
  });

  it("never writes credentials into the log line", async () => {
    const url = new URL(getTestDatabaseUrl());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const report = await logDbRoleDiagnostic(testPool);
      expect(report).not.toBeNull();
      const output = [...log.mock.calls, ...warn.mock.calls].flat().join("\n");
      expect(output).toContain("[startup:db-role]");
      if (url.password) expect(output).not.toContain(decodeURIComponent(url.password));
      expect(output).not.toMatch(/postgres(ql)?:\/\//i);
      expect(output).not.toContain(url.hostname === "localhost" ? "\u0000" : url.hostname);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("logs a failure without throwing and without leaking error internals", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const report = await logDbRoleDiagnostic({
        query: (async () => {
          throw Object.assign(new Error("connection refused"), { host: "secret-host.example", password: "hunter2" });
        }) as never,
      });
      expect(report).toBeNull();
      const output = err.mock.calls.flat().join("\n");
      expect(output).toContain("[startup:db-role] diagnostic failed -- connection refused");
      expect(output).not.toContain("secret-host.example");
      expect(output).not.toContain("hunter2");
    } finally {
      err.mockRestore();
    }
  });
});
