import { describe, expect, it } from "vitest";
import { renderImageName } from "@/server/render/runner";

describe("renderImageName", () => {
  it("defaults to ytstudio-render:dev", () => expect(renderImageName({})).toBe("ytstudio-render:dev"));
  it("accepts a registry reference with a tag", () =>
    expect(renderImageName({ RENDER_IMAGE: "ghcr.io/x/ytstudio-render:1.2.3" })).toBe("ghcr.io/x/ytstudio-render:1.2.3"));
  it("refuses a value with spaces or flags", () => {
    for (const bad of ["a b", "--rm", "img:tag --privileged", ""]) {
      expect(() => renderImageName({ RENDER_IMAGE: bad })).toThrow("not a valid image reference");
    }
  });
});
