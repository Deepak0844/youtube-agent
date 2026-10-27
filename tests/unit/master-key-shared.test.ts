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
});
