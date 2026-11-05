import { describe, expect, it } from "vitest";
import { buildPreviewsBody, pickStills } from "@/server/core/scene3d-stills";
import { LOOK_SEND_BACK_CAP, LOOK_UNREADABLE, lookSendBackProblem, lookView, scene3dNativeNote, timeLabel } from "@/server/core/scene3d-view";
import { scene3dSchema } from "@/shared/scene3d";

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

const scene = scene3dSchema.parse({ version: 2, elements: [{ kind: "box", id: "b", size_m: [2, 2, 2] }], shots: ["hook", "setup", "dig", "load", "pour", "reveal"].map((id) => ({ id, duration_s: 6, focus: "b", caption: `Caption ${id}` })) });
const picks = pickStills(scene);
const previews = buildPreviewsBody({ sceneSha256: "a".repeat(64), picks, shas: picks.map(() => "b".repeat(64)), advice: { status: "done", notes: ["Image 2 is mostly empty."] } });

describe("lookView", () => {
  it("pairs every picture with its shot, caption and time, and carries the missing-asset report and the advice", () => {
    const v = lookView(previews, { kind: "scene3d", scene: {}, missing_assets: [{ beat: "dig", wanted: "an excavator", substitute: "a dump truck" }] });
    if (!v.ok) throw new Error(v.message);
    expect(v.look.stills).toHaveLength(picks.length);
    expect(v.look.stills[0]).toEqual({ file: "stills/01.png", timeS: 0.5, shot: "hook", caption: "Caption hook" });
    expect(v.look.missing).toEqual([{ beat: "dig", wanted: "an excavator", substitute: "a dump truck" }]);
    expect(v.look.advice).toEqual({ status: "done", notes: ["Image 2 is mostly empty."] });
  });
  it("an unreadable missing_assets list shows as empty instead of hiding the pictures", () => {
    const v = lookView(previews, { missing_assets: "nope" });
    expect(v.ok && v.look.missing).toEqual([]);
  });
  it("a body that is not a valid previews body gives one plain message, never a crash", () => {
    for (const bad of [null, {}, "x", { ...previews, stills: [] }]) expect(lookView(bad, {})).toEqual({ ok: false, message: LOOK_UNREADABLE });
  });
});

describe("lookSendBackProblem", () => {
  it("allows three send-backs and then refuses with a plain sentence", () => {
    expect(LOOK_SEND_BACK_CAP).toBe(3);
    for (const used of [0, 1, 2]) expect(lookSendBackProblem(used)).toBeNull();
    expect(lookSendBackProblem(3)).toMatch(/sent this look back 3 times/);
    expect(lookSendBackProblem(9)).not.toBeNull();
  });
});

describe("timeLabel", () => {
  it("rounds to a tenth of a second", () => {
    expect(timeLabel(12.5)).toBe("12.5 s");
    expect(timeLabel(0.5004)).toBe("0.5 s");
    expect(timeLabel(3)).toBe("3 s");
  });
});
