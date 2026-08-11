/**
 * Login throttling must bound password guessing.
 *
 * Regression guard for a real hole: the throttle keyed itself on
 * X-Forwarded-For, which any caller can set. Rotating that header put every
 * guess in a fresh bucket, so the limit was decorative and the admin password
 * could be brute-forced without limit. Proxy headers are now only read when
 * the operator opts in, and a global ceiling backstops the per-source count.
 *
 * DATA_DIR is captured when lib/ui/env is first imported, so the temp
 * directory has to be set before the dynamic import below.
 */
import { describe, expect, it, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * next/headers throws outside a request scope, so the header bag is faked.
 * `headerBag.current` is what an attacker would vary between requests.
 */
const headerBag = vi.hoisted(() => ({ current: {} as Record<string, string> }));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => headerBag.current[k.toLowerCase()] ?? null }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

type AuthModule = typeof import("../lib/ui/auth.js");
let auth: AuthModule;

beforeAll(async () => {
  process.env["OPNMESH_DATA_DIR"] = mkdtempSync(join(tmpdir(), "opnmesh-throttle-"));
  delete process.env["OPNMESH_TRUST_PROXY"];
  auth = await import("../lib/ui/auth.js");
  await auth.createAdminAccount("the-real-admin-password", auth.bootstrapToken());
});

/** One sign-in attempt from a caller claiming to come from `xff`. */
async function guess(password: string, xff?: string) {
  headerBag.current = xff ? { "x-forwarded-for": xff } : {};
  return auth.login(password);
}

describe("login throttling", () => {
  it("stops counting a caller's guesses separately just because they change X-Forwarded-For", async () => {
    // Spend the per-source allowance from one claimed address.
    for (let i = 0; i < 5; i++) {
      expect((await guess(`wrong-${i}-aaaaaaaa`, "203.0.113.5")).ok).toBe(false);
    }
    expect((await guess("wrong-again-aaaa", "203.0.113.5")).throttled).toBe(true);

    // The exploit: a fresh address on every request. Each of these used to be
    // treated as a brand new client with a full allowance.
    for (let i = 0; i < 10; i++) {
      const result = await guess(`wrong-${i}-bbbbbbbb`, `198.51.100.${i}`);
      expect(result.ok).toBe(false);
      expect(result.throttled, `guess ${i} with a new X-Forwarded-For was allowed through`).toBe(true);
    }
  });

  it("admits the correct password even while throttled — the operator is never locked out", async () => {
    // Fill the shared bucket so throttled() is true for everyone.
    for (let i = 0; i < 8; i++) await guess(`wrong-${i}-cccccccc`, "203.0.113.9");
    expect((await guess("still-wrong-cccc", "203.0.113.9")).throttled).toBe(true);

    // The regression this guards: a full failure ledger used to block the
    // success path too, so an attacker could lock the sole admin out. A
    // correct password must win regardless of the throttle state.
    const good = await guess("the-real-admin-password", "203.0.113.9");
    expect(good.ok).toBe(true);

    // Success clears the ledger, so the next caller starts clean.
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(join(process.env["OPNMESH_DATA_DIR"]!, "ui.db"));
    const row = db.prepare("SELECT COUNT(*) AS n FROM login_failures").get() as { n: number };
    db.close();
    expect(row.n).toBe(0);
  });

  it("lets the real operator back in, and clears the ledger on success", async () => {
    // Throttling is time-boxed, not permanent, so the window is stepped over
    // by ageing the recorded failures rather than by sleeping.
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(join(process.env["OPNMESH_DATA_DIR"]!, "ui.db"));
    db.prepare("UPDATE login_failures SET ts = ?").run(Date.now() - 16 * 60 * 1000);
    db.close();

    const good = await guess("the-real-admin-password", "203.0.113.5");
    expect(good.ok).toBe(true);

    const db2 = new Database(join(process.env["OPNMESH_DATA_DIR"]!, "ui.db"));
    const row = db2.prepare("SELECT COUNT(*) AS n FROM login_failures").get() as { n: number };
    db2.close();
    // A correct password proves the operator is present, so nothing is left
    // behind that an attacker could have parked to cause a lockout later.
    expect(row.n).toBe(0);
  });
});
