import { describe, expect, it } from "vitest";
import { hostPathFor, hostPathMapFrom } from "@/server/core/host-paths";

const map = { from: "/data", to: "/srv/studio/data" };

describe("host paths", () => {
  it("rewrites a path under the root", () =>
    expect(hostPathFor("/data/attempts/a1/render-in", map)).toBe("/srv/studio/data/attempts/a1/render-in"));
  it("leaves paths alone without a map", () => expect(hostPathFor("/data/x", null)).toBe("/data/x"));
  it("refuses a path outside the root, including a prefix trick", () => {
    expect(() => hostPathFor("/tmp/x", map)).toThrow("outside the storage root");
    expect(() => hostPathFor("/data2/x", map)).toThrow("outside the storage root");
  });
  it("builds the map only when HOST_STORAGE_ROOT is set", () => {
    expect(hostPathMapFrom({}, "/data")).toBeNull();
    expect(hostPathMapFrom({ HOST_STORAGE_ROOT: "/srv/studio/data" }, "/data")).toEqual(map);
    expect(() => hostPathMapFrom({ HOST_STORAGE_ROOT: "relative" }, "/data")).toThrow("absolute");
  });
});
