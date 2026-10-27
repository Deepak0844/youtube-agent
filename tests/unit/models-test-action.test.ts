import { beforeEach, describe, expect, it, vi } from "vitest";

// The Test action can spend money. If requireOwner() throws (no or invalid session redirects), nothing else may run:
// no pool, no keyring, no model call.
const touched = vi.hoisted(() => ({ pool: vi.fn(), keyring: vi.fn(), test: vi.fn(), deps: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/auth/require-owner", () => ({
  requireOwner: vi.fn(async () => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/server/db/pool", () => ({ getPool: () => (touched.pool(), {}) }));
vi.mock("@/server/db/master-key", () => ({ loadKeyring: () => (touched.keyring(), {}) }));
vi.mock("@/server/db/llm-test", () => ({ testModel: touched.test }));
vi.mock("@/server/llm/default-deps", () => ({ defaultModelDeps: touched.deps }));
vi.mock("next/cache", () => ({ refresh: touched.refresh }));

import { testModelAction } from "@/app/(app)/settings/models/actions";

describe("test_is_session_only: the Test action authenticates first", () => {
  beforeEach(() => vi.clearAllMocks());

  it("without_a_session_nothing_is_touched", async () => {
    const f = new FormData();
    f.set("rowId", "00000000-0000-4000-8000-000000000001");
    await expect(testModelAction({}, f)).rejects.toThrow("NEXT_REDIRECT");
    for (const fn of Object.values(touched)) expect(fn).not.toHaveBeenCalled();
  });
});
