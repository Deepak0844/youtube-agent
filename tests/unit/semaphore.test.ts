import { describe, expect, it } from "vitest";
import { createSemaphore } from "@/server/core/semaphore";

describe("semaphore", () => {
  it("never_more_than_n_in_flight_and_runs_all", async () => {
    const s = createSemaphore(2);
    let now = 0;
    let peak = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        s.run(async () => {
          now++;
          peak = Math.max(peak, now);
          await new Promise((r) => setTimeout(r, 5));
          now--;
          done++;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(done).toBe(12);
  });
  it("releases_on_throw", async () => {
    const s = createSemaphore(1);
    await expect(s.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(s.run(async () => 7)).resolves.toBe(7);
  });
  it("rejects_bad_size", () => {
    expect(() => createSemaphore(0)).toThrow();
  });
});
