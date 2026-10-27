import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// Next bundles each route/action graph with its own copy of this module. The env var is deleted after the first read,
// so a second copy that kept its own cache would find no key and fail ("vault unreadable") depending on which route
// ran first. The parsed keyring must therefore be shared process-wide.
afterEach(async () => {
  const m = await import("@/server/db/master-key");
  m.resetKeyringCacheForTests();
  delete process.env.VAULT_MASTER_KEY;
  vi.resetModules();
});

describe("loadKeyring across module copies", () => {
  it("a_second_copy_of_the_module_reuses_the_keyring_after_the_env_var_is_gone", async () => {
    process.env.VAULT_MASTER_KEY = randomBytes(32).toString("base64");
    const a = await import("@/server/db/master-key");
    a.resetKeyringCacheForTests();
    const ringA = a.loadKeyring();
    expect(process.env.VAULT_MASTER_KEY).toBeUndefined();
    vi.resetModules();
    const b = await import("@/server/db/master-key");
    expect(b).not.toBe(a);
    expect(b.loadKeyring()).toBe(ringA);
  });

  it("the_keyring_and_its_key_objects_are_frozen", async () => {
    const m = await import("@/server/db/master-key");
    const ring = m.loadKeyring({ VAULT_MASTER_KEY: randomBytes(32).toString("base64"), VAULT_MASTER_KEY_PREVIOUS: randomBytes(32).toString("base64") });
    expect(Object.isFrozen(ring)).toBe(true);
    expect(Object.isFrozen(ring.current)).toBe(true);
    for (const k of ring.byId.values()) expect(Object.isFrozen(k)).toBe(true);
    expect(() => {
      (ring as { current: unknown }).current = null;
    }).toThrow();
    expect(() => (ring.byId as Map<string, unknown>).set("x", {})).toThrow();
    expect(() => (ring.byId as Map<string, unknown>).delete(ring.current.id)).toThrow();
    expect(() => (ring.byId as Map<string, unknown>).clear()).toThrow();
  });
});
