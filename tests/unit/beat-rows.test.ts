import { describe, expect, it } from "vitest";
import { buildBeatRows } from "@/server/core/beat-rows";

describe("buildBeatRows", () => {
  it("maps id, text, visual", () => {
    expect(buildBeatRows([{ id: "hook", text: "Hi", visual: "A box" }])).toEqual([{ name: "hook", line: "Hi", action: "A box" }]);
  });
  it("old beats without visual or id still render", () => {
    expect(buildBeatRows([{ text: "Old" }, "junk"])).toEqual([
      { name: "beat-1", line: "Old", action: "" },
      { name: "beat-2", line: "", action: "" },
    ]);
  });
});
