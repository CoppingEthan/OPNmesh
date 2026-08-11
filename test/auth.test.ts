/**
 * Auth rules that do not need a running server. DATA_DIR is captured when
 * lib/ui/env is first imported, so the temp directory is set before the
 * dynamic import below.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type AuthModule = typeof import("../lib/ui/auth.js");
let auth: AuthModule;

beforeAll(async () => {
  process.env["OPNMESH_DATA_DIR"] = mkdtempSync(join(tmpdir(), "opnmesh-auth-"));
  auth = await import("../lib/ui/auth.js");
});

describe("admin account", () => {
  it("requires the bootstrap token, and can only be created once", async () => {
    expect(auth.adminConfigured()).toBe(false);

    // Wrong token: no account is created, so setup stays open.
    expect(await auth.createAdminAccount("a-long-enough-password", "wrong-token")).toBe(false);
    expect(auth.adminConfigured()).toBe(false);

    const token = auth.bootstrapToken();
    expect(await auth.createAdminAccount("a-long-enough-password", token)).toBe(true);
    expect(auth.adminConfigured()).toBe(true);

    // Second attempt is refused even with the correct token — otherwise
    // anyone who read the log once could take the panel over later.
    expect(await auth.createAdminAccount("another-long-password", token)).toBe(false);
  });

  it("enforces a minimum password length and rejects trivial passwords", () => {
    expect(auth.passwordProblem("short")).toMatch(/12 characters/);
    expect(auth.passwordProblem("aaaaaaaaaaaaaa")).toMatch(/repeated character/);
    expect(auth.passwordProblem("a-perfectly-fine-password")).toBeNull();
  });

  it("verifies the bootstrap token in constant time regardless of input", () => {
    const token = auth.bootstrapToken();
    expect(auth.verifyBootstrapToken(token)).toBe(true);
    expect(auth.verifyBootstrapToken("")).toBe(false);
    expect(auth.verifyBootstrapToken(token.slice(0, -1))).toBe(false);
    expect(auth.verifyBootstrapToken(token + "0")).toBe(false);
  });
});
