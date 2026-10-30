import { describe, expect, it } from "vitest";
import { parseArgs, planPreview } from "../../scripts/kit-preview-lib";

const doc = (scene: object) => JSON.stringify({ version: 1, scenes: [{ id: "s1", beat: "b1", startMs: 0, durationMs: 2000, ...scene }] });

describe("parseArgs", () => {
  it("needs exactly one file", () => {
    expect(parseArgs(["--", "a.json"])).toEqual({ file: "a.json" });
    expect(parseArgs([])).toHaveProperty("error");
    expect(parseArgs(["a", "b"])).toHaveProperty("error");
  });
});

describe("planPreview", () => {
  it("plans frame 0, middle, last", () => {
    const r = planPreview(doc({ kind: "chat_thread", messages: [{ from: "user", text: "hi" }] }));
    expect(r.ok && r.plans[0]!.frames).toEqual([0, 29, 59]);
  });
  it("reports plain-text errors", () => {
    const r = planPreview(doc({ kind: "chat_thread", durationMs: 10, messages: [] }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.length).toBeGreaterThan(0);
    expect(planPreview("{nope")).toMatchObject({ ok: false });
  });
});
