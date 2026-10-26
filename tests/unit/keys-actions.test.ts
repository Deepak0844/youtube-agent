import { beforeEach, describe, expect, it, vi } from "vitest";

// If requireOwner() throws (no/invalid session makes it redirect), an action must stop before it touches the database pool or
// the vault keyring. This proves the guard runs FIRST in each action, not just somewhere in it.
const touched = vi.hoisted(() => ({ pool: vi.fn(), keyring: vi.fn(), db: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/auth/require-owner", () => ({
  requireOwner: vi.fn(async () => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/server/db/pool", () => ({ getPool: () => (touched.pool(), {}) }));
vi.mock("@/server/db/master-key", () => ({ loadKeyring: () => (touched.keyring(), {}) }));
vi.mock("@/server/db/provider-keys", () => ({
  saveProviderKey: touched.db,
  removeProviderKey: touched.db,
  testProviderKey: touched.db,
}));
vi.mock("next/cache", () => ({ refresh: touched.refresh }));

import { removeKeyAction, setKeyAction, testKeyAction } from "@/app/(app)/settings/keys/actions";

const form = () => {
  const f = new FormData();
  f.set("provider", "anthropic");
  f.set("value", "sk-ant-api03-whatever-whatever-whatever");
  return f;
};

describe("server actions authenticate before doing anything", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    ["setKeyAction", setKeyAction],
    ["removeKeyAction", removeKeyAction],
    ["testKeyAction", testKeyAction],
  ])("%s: a failed requireOwner means no pool, no keyring, no db call, no refresh", async (_n, action) => {
    await expect(action({}, form())).rejects.toThrow("NEXT_REDIRECT");
    expect(touched.pool).not.toHaveBeenCalled();
    expect(touched.keyring).not.toHaveBeenCalled();
    expect(touched.db).not.toHaveBeenCalled();
    expect(touched.refresh).not.toHaveBeenCalled();
  });
});
