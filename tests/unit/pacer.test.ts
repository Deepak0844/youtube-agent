import { describe, expect, it } from "vitest";
import { createPacer } from "@/server/llm/pacer";

function fake() {
  let t = 0;
  const sleeps: number[] = [];
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      sleeps.push(ms);
      const id = setTimeout(() => { t += ms; resolve(); }, 0);
      signal?.addEventListener("abort", () => { clearTimeout(id); reject(signal.reason); }, { once: true });
    });
  return { now: () => t, sleep, sleeps, advance: (ms: number) => { t += ms; } };
}

describe("pacer", () => {
  it("first call never waits, second waits the gap", async () => {
    const f = fake();
    const p = createPacer(f.now, f.sleep);
    await p.wait("a", 4000);
    await p.wait("a", 4000);
    expect(f.sleeps).toEqual([4000]);
  });
  it("different keys are independent", async () => {
    const f = fake();
    const p = createPacer(f.now, f.sleep);
    await p.wait("a", 4000);
    await p.wait("b", 4000);
    expect(f.sleeps).toEqual([]);
  });
  it("gap 0 never sleeps", async () => {
    const f = fake();
    const p = createPacer(f.now, f.sleep);
    await p.wait("a", 0);
    await p.wait("a", 0);
    expect(f.sleeps).toEqual([]);
  });
  it("no wait after idle longer than the gap, and a partial wait is only the remainder", async () => {
    const f = fake();
    const p = createPacer(f.now, f.sleep);
    await p.wait("a", 4000);
    f.advance(1000);
    await p.wait("a", 4000);
    f.advance(5000);
    await p.wait("a", 4000);
    expect(f.sleeps).toEqual([3000]);
  });
  it("queues concurrent callers in order, each a gap apart", async () => {
    const f = fake();
    const p = createPacer(f.now, f.sleep);
    const order: number[] = [];
    const starts: number[] = [];
    await Promise.all([1, 2, 3].map((n) => p.wait("a", 1000).then(() => { order.push(n); starts.push(f.now()); })));
    expect(order).toEqual([1, 2, 3]);
    expect(starts).toEqual([0, 1000, 2000]);
  });
  it("abort rejects with the reason, even when queued, and skips its slot", async () => {
    const f = fake();
    const p = createPacer(f.now, f.sleep);
    await p.wait("a", 1000);
    const ac = new AbortController();
    const w = p.wait("a", 1000, ac.signal);
    ac.abort(new Error("cancelled"));
    await expect(w).rejects.toThrow("cancelled");
    await expect(p.wait("a", 1000, ac.signal)).rejects.toThrow("cancelled");
    await p.wait("a", 1000);
    expect(f.sleeps.length).toBeLessThanOrEqual(2);
  });
});
