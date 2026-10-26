import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ fail: false }));
vi.mock("node:crypto", async (orig) => {
  const a = await orig<typeof import("node:crypto")>();
  const scrypt = ((...args: unknown[]) => {
    if (state.fail) {
      const cb = args[args.length - 1] as (e: Error) => void;
      cb(new Error("boom"));
      return;
    }
    return (a.scrypt as (...x: unknown[]) => unknown)(...args);
  }) as typeof a.scrypt;
  return { ...a, scrypt, default: { ...a, scrypt } };
});

import { dummyVerify } from "@/server/core/auth-crypto";

describe("dummyVerify", () => {
  it("never_throws_even_when_scrypt_fails", async () => {
    state.fail = true;
    await expect(dummyVerify()).resolves.toBeUndefined();
    state.fail = false;
    await expect(dummyVerify()).resolves.toBeUndefined();
  });
});
