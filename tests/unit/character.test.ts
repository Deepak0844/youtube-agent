import { describe, expect, it } from "vitest";
import { characterProblem, MIN_CHARACTER_SIDE, type CharacterAsset } from "@/server/core/character";

const ok: CharacterAsset = { kind: "image", mime: "image/png", width: 1024, height: 1536, deleted: false };

describe("characterProblem", () => {
  it("accepts a normal PNG or JPEG portrait", () => {
    expect(characterProblem(ok)).toBeNull();
    expect(characterProblem({ ...ok, mime: "image/jpeg" })).toBeNull();
  });
  it("refuses a deleted picture, a non-picture, webp or gif, unknown or tiny sizes", () => {
    expect(characterProblem({ ...ok, deleted: true })).toMatch(/deleted/);
    expect(characterProblem({ ...ok, kind: "video" })).toMatch(/has to be a picture/);
    for (const mime of ["image/webp", "image/gif", "image/svg+xml", ""]) expect(characterProblem({ ...ok, mime }), mime).toMatch(/PNG or JPEG/);
    expect(characterProblem({ ...ok, width: null })).toMatch(/size is not known/);
    expect(characterProblem({ ...ok, height: 0 })).toMatch(/size is not known/);
    expect(characterProblem({ ...ok, width: MIN_CHARACTER_SIDE - 1 })).toMatch(/at least 300/);
    expect(characterProblem({ ...ok, width: MIN_CHARACTER_SIDE, height: MIN_CHARACTER_SIDE })).toBeNull();
  });
  it("keeps the shape between 2:5 and 5:2", () => {
    expect(characterProblem({ ...ok, width: 400, height: 1000 })).toBeNull();
    expect(characterProblem({ ...ok, width: 1000, height: 400 })).toBeNull();
    expect(characterProblem({ ...ok, width: 400, height: 1001 })).toMatch(/2\.5 times/);
    expect(characterProblem({ ...ok, width: 1001, height: 400 })).toMatch(/2\.5 times/);
  });
});
