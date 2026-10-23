import { describe, expect, it } from "vitest";
import { x } from "@/server/core/sanity";

describe("alias and unit project wiring", () => {
  it("resolves @/ to src", () => {
    expect(x()).toBe(1);
  });
});
