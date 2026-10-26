import { afterEach, describe, expect, it, vi } from "vitest";

// Next bundles server modules once per entry (route handler, server action, page). The admission state must therefore
// live on globalThis, not in the module, or every bundle grants the full cap.
type AuthModule = typeof import("@/server/db/auth");
const hang = { query: () => new Promise(() => {}) } as never; // a login that holds its admission slot forever

afterEach(async () => {
  (await import("@/server/db/auth")).configureAuthAdmission({ maxInFlightAuth: 1000, maxPerIp: 1000 }); // release held slots
  vi.resetModules();
});

describe("auth admission is shared across module copies", () => {
  it("a slot taken through copy A is seen and enforced by copy B", async () => {
    vi.resetModules();
    const a: AuthModule = await import("@/server/db/auth");
    vi.resetModules();
    const b: AuthModule = await import("@/server/db/auth");
    expect(a).not.toBe(b); // really two instances

    a.configureAuthAdmission({ maxInFlightAuth: 1, maxPerIp: 1 });
    void a.login(hang, { username: "u", password: "p", ip: "1.1.1.1" });
    expect(a.authInFlight()).toBe(1);
    expect(b.authInFlight()).toBe(1);
    expect(await b.login(hang, { username: "u", password: "p", ip: "2.2.2.2" })).toEqual({ ok: false, reason: "busy" });
  });

  it("configure through one copy replaces the shared instance for the other", async () => {
    vi.resetModules();
    const a: AuthModule = await import("@/server/db/auth");
    vi.resetModules();
    const b: AuthModule = await import("@/server/db/auth");
    b.configureAuthAdmission({ maxInFlightAuth: 1, maxPerIp: 1 });
    void a.login(hang, { username: "u", password: "p", ip: "3.3.3.3" });
    expect(await a.login(hang, { username: "u", password: "p", ip: "4.4.4.4" })).toEqual({ ok: false, reason: "busy" });
  });
});
