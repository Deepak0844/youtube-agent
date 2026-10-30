import { describe, expect, it } from "vitest";
import { kinds } from "@/shared/scene/kinds";
import { KIT_RENDERED_KINDS } from "../../remotion/kit/rendered";

describe("KitScene covers the scene registry", () => {
  it("has a case for every registered kind, and no extras", () => {
    expect([...KIT_RENDERED_KINDS].sort()).toEqual(Object.keys(kinds).sort());
  });
});
