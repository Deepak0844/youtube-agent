import { describe, expect, it } from "vitest";
import { classifyError, nextBackoffMs, NotProcessedError } from "@/server/core/error-class";

// Owner decision: unclear outcomes are NEVER retried. Only a clear "provider rejected it, nothing was processed" is transient.
describe("classifyError", () => {
  const np = (status?: number, code?: string) => new NotProcessedError("rejected", { status, code });
  const table: Array<[string, unknown, "transient" | "permanent" | "unknown"]> = [
    ["429 before processing", np(429), "transient"],
    ["408 is unclear (work may have started)", np(408), "unknown"],
    ["500 is unclear", np(500), "unknown"],
    ["503 is unclear", np(503), "unknown"],
    ["599 is unclear", np(599), "unknown"],
    ["connection refused before send", np(undefined, "ECONNREFUSED"), "transient"],
    ["DNS failure before send", np(undefined, "ENOTFOUND"), "transient"],
    ["400 rejected", np(400), "permanent"],
    ["401 rejected", np(401), "permanent"],
    ["rejected with no detail", np(), "permanent"],
    ["socket hang up after send", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), "unknown"],
    ["abort after send", Object.assign(new Error("aborted"), { name: "AbortError" }), "unknown"],
    ["timeout after send", Object.assign(new Error("timeout"), { name: "TimeoutError" }), "unknown"],
    ["429 NOT marked as unprocessed", Object.assign(new Error("429"), { status: 429 }), "unknown"],
    ["500 NOT marked as unprocessed", Object.assign(new Error("500"), { status: 500 }), "unknown"],
    ["plain error", new Error("boom"), "unknown"],
    ["a string", "boom", "unknown"],
    ["null", null, "unknown"],
    ["a lookalike object claiming the mark", { notProcessed: true, status: 429 }, "unknown"],
  ];
  for (const [name, err, want] of table) it(name, () => expect(classifyError(err)).toBe(want));
});

describe("nextBackoffMs", () => {
  it("backoff_schedule_30_120_480_then_exhausted", () => {
    const s = [30, 120, 480];
    expect([0, 1, 2].map((i) => nextBackoffMs(i, s))).toEqual([30_000, 120_000, 480_000]);
    expect(nextBackoffMs(3, s)).toBeNull();
    expect(nextBackoffMs(-1, s)).toBeNull();
    expect(nextBackoffMs(1.5, s)).toBeNull();
    expect(nextBackoffMs(0, [])).toBeNull();
  });
});
