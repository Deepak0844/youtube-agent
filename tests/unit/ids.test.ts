import { beforeEach, describe, expect, it, vi } from "vitest";

type Uuidv7 = typeof import("@/server/core/ids").uuidv7;
let uuidv7: Uuidv7;
// Fresh module per test: uuidv7 keeps last-timestamp state for monotonicity.
beforeEach(async () => {
  vi.resetModules();
  ({ uuidv7 } = await import("@/server/core/ids"));
});

const fixedRandom = (n: number) => new Uint8Array(n).fill(0xab);

describe("uuidv7", () => {
  it("has version nibble 7 and RFC variant bits", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("encodes the injected timestamp in the first 48 bits", () => {
    const ms = 0x0123456789ab;
    expect(uuidv7(ms, fixedRandom).startsWith("01234567-89ab-7")).toBe(true);
  });

  it("sorts by time across milliseconds", () => {
    const ids = [1000, 1001, 5000, 99999999].map((t) => uuidv7(t, fixedRandom));
    expect([...ids].sort()).toEqual(ids);
  });

  it("stays strictly increasing within the same millisecond", () => {
    const ids = Array.from({ length: 50 }, () => uuidv7(2_000_000, fixedRandom));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  it("stays increasing if the clock goes backwards", () => {
    const a = uuidv7(3_000_000, fixedRandom);
    const b = uuidv7(2_999_000, fixedRandom);
    expect(b > a).toBe(true);
  });

  it("is unique with real randomness", () => {
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7())).size).toBe(1000);
  });
});
