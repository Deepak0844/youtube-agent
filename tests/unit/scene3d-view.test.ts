import { describe, expect, it } from "vitest";
import { buildPreviewsBody, pickStills } from "@/server/core/scene3d-stills";
import { LOOK_SEND_BACK_CAP, LOOK_UNREADABLE, lookSendBackProblem, lookView, SCENE3D_EMPTY, SCENE3D_UNREADABLE, scene3dNativeNote, scene3dSummary, timeLabel } from "@/server/core/scene3d-view";
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
  it("an AI-written scene shows the models its code names on the Look card, and a director scene shows none", () => {
    const code = lookView(previews, { kind: "scene3d_code", source: "x", models: ["pp_ship", 7, "pp_crane"] });
    expect(code.ok && code.look.models).toEqual(["pp_ship", "pp_crane"]);
    expect(code.ok && code.look.missing).toEqual([]);
    const director = lookView(previews, { kind: "scene3d", scene: {}, missing_assets: [], models: ["pp_ship"] });
    expect(director.ok && "models" in director.look).toBe(false);
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

describe("scene3dSummary", () => {
  const full = scene3dSchema.parse({
    version: 2,
    elements: [
      { kind: "water", id: "sea", size_m: [400, 200] },
      { kind: "model", id: "barge", model: { catalog: "pp_ship" }, height_m: 20 },
      { kind: "sand_pile", id: "mound", radius_m: 10, height_m: 4 },
    ],
    shots: [
      { id: "hook", duration_s: 6, focus: "barge", caption: "Hook" },
      { id: "hook_2", duration_s: 4.5, focus: ["barge", "mound"] },
      { id: "dig", duration_s: 5 },
    ],
  });
  const body = { kind: "scene3d", scene: full, missing_assets: [{ beat: "dig", wanted: "an excavator", substitute: "a dump truck" }] };
  const story = [{ id: "hook", visual: "A tall skyline rises over the sea", line: "x" }, { id: "dig", visual: "Workers stand on the sand", line: "y" }];
  const names = (id: string) => (id === "pp_ship" ? "Cargo Ship" : null);

  it("lists the shots with start times, the visual line of their story beat, captions and what the camera frames", () => {
    const v = scene3dSummary(body, story, names);
    if (!v.ok) throw new Error(v.message);
    expect(v.summary.totalS).toBe(15.5);
    expect(v.summary.shots.map((s) => [s.n, s.id, s.startS, s.durationS, s.beat])).toEqual([[1, "hook", 0, 6, "hook"], [2, "hook_2", 6, 4.5, "hook"], [3, "dig", 10.5, 5, "dig"]]);
    expect(v.summary.shots[0]).toMatchObject({ visual: "A tall skyline rises over the sea", caption: "Hook", focus: "Cargo Ship" });
    expect(v.summary.shots[1]!.focus).toBe("Cargo Ship, mound (sand pile)");
    expect(v.summary.shots[2]).toMatchObject({ focus: "free camera", caption: null, visual: "Workers stand on the sand" });
  });
  it("names catalogue models and plain blocks, and carries the missing-asset report", () => {
    const v = scene3dSummary(body, story, names);
    if (!v.ok) throw new Error(v.message);
    expect(v.summary.objects).toEqual([
      { id: "sea", isModel: false, label: "water" },
      { id: "barge", isModel: true, label: "Cargo Ship (pp_ship)" },
      { id: "mound", isModel: false, label: "sand pile" },
    ]);
    expect(v.summary.missing).toEqual([{ beat: "dig", wanted: "an excavator", substitute: "a dump truck" }]);
    const unnamed = scene3dSummary(body, story, () => null);
    expect(unnamed.ok && unnamed.summary.objects[1]!.label).toBe("pp_ship (pp_ship)");
  });
  it("still shows the shots when the script has no usable story", () => {
    for (const bad of [null, undefined, "x", [{ nope: 1 }]]) {
      const v = scene3dSummary(body, bad, names);
      expect(v.ok && v.summary.shots.every((s) => s.visual === null && s.beat === null)).toBe(true);
    }
  });
  it("an empty or invalid scene gives one plain message", () => {
    expect(scene3dSummary(null, story, names)).toEqual({ ok: false, message: SCENE3D_EMPTY });
    expect(scene3dSummary(undefined, story, names)).toEqual({ ok: false, message: SCENE3D_EMPTY });
    for (const bad of [{}, "x", { scene: { version: 2 } }, { scene: { ...full, shots: [] } }]) expect(scene3dSummary(bad, story, names)).toEqual({ ok: false, message: SCENE3D_UNREADABLE });
  });
});
