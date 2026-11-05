import { describe, expect, it } from "vitest";
import { scene3dNativeNote } from "@/server/core/scene3d-view";

describe("scene3dNativeNote", () => {
  it("is empty only when the setting is on and the preflight says ready", () => {
    expect(scene3dNativeNote(true, { ready: true, message: "Ready." })).toBeNull();
  });
  it("leads with the fix, naming the setting and the browser command, when the setting is off", () => {
    const n = scene3dNativeNote(false, null)!;
    expect(n).toContain("render.native_3d");
    expect(n).toContain("npx remotion browser ensure");
    expect(n.startsWith("Turn on")).toBe(true);
  });
  it("adds the preflight reason when the setting is on but this Mac is not ready", () => {
    const n = scene3dNativeNote(true, { ready: false, message: "Not ready: the Chrome headless shell is not downloaded yet." })!;
    expect(n).toContain("npx remotion browser ensure");
    expect(n).toContain("Chrome headless shell");
  });
});
