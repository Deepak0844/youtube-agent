import { describe, expect, it } from "vitest";
import { checkBeatRoles, estimateBeatTimes, roleGuidance, roleOf, ROLE_GUIDANCE, withTimeEstimates } from "@/shared/scene/beat-roles";
import { validateScript } from "@/server/core/script-contract";
import { wordRange } from "@/server/core/lang";
import { retimeScenes, MAX_TAIL_MS } from "@/shared/scene/retime";
import { validateScenes } from "@/shared/scene";
import { slideshowRisk } from "@/shared/scene/slideshow";
import { loopOpacity, loopOverlay } from "../../remotion/kit/timeline";
import { pickMessages } from "@/server/core/scene-build";

describe("checkBeatRoles", () => {
  it("accepts the full grammar and free-form ids between", () => {
    expect(checkBeatRoles(["hook", "setup", "quiz", "reveal", "reveal-2", "twist", "loop"])).toEqual([]);
    expect(checkBeatRoles(["hook", "setup", "trap", "reveal", "payoff", "loop"])).toEqual([]);
    expect(checkBeatRoles(["hook", "reveal", "loop"])).toEqual([]);
  });
  it("rejects wrong first, last, missing reveal and bad order", () => {
    expect(checkBeatRoles(["setup", "reveal", "loop"]).join()).toMatch(/first/);
    expect(checkBeatRoles(["hook", "reveal", "twist"]).join()).toMatch(/last/);
    expect(checkBeatRoles(["hook", "setup", "loop"]).join()).toMatch(/reveal/);
    expect(checkBeatRoles(["hook", "twist", "reveal", "loop"]).join()).toMatch(/out of order/);
  });
  it("roleOf", () => {
    expect(roleOf("reveal_3")).toBe("reveal");
    expect(roleOf("payoff")).toBeNull();
  });
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const script = (ids: string[]) => ({ narration: words(wordRange("en").min), beats: ids.map((id) => ({ id })), title: "T", evidence: [{ text: "c", kind: "computed", method: "m" }] });
describe("validateScript beat roles", () => {
  it("only checked for scene_kit shorts", () => {
    expect(validateScript(script(["hook"]), "en", "short", { kind: "scene_kit" }).ok).toBe(false);
    expect(validateScript(script(["hook"]), "en", "short").ok).toBe(true); // old scripts / other kinds
    expect(validateScript(script(["hook"]), "en", "long", { kind: "scene_kit" }).ok).toBe(true);
    expect(validateScript(script(["hook", "reveal", "loop"]), "en", "short", { kind: "scene_kit" }).ok).toBe(true);
  });
  it("still allows est_start/est_end", () => {
    const s = script(["hook", "reveal", "loop"]);
    const withEst = { ...s, beats: s.beats.map((b) => ({ ...b, est_start: 0, est_end: 2 })) };
    expect(validateScript(withEst, "en", "short", { kind: "scene_kit" }).ok).toBe(true);
  });
});

describe("timing estimates", () => {
  it("2.7 words/sec, end reaches the next start", () => {
    const t = estimateBeatTimes([words(27), words(27), words(27)]);
    expect(t[0]).toEqual({ est_start: 0, est_end: 10 });
    expect(t[1]).toEqual({ est_start: 10, est_end: 20 });
    expect(t[2]).toEqual({ est_start: 20, est_end: 30 });
  });
  it("adds fields only when all beats have text", () => {
    expect(withTimeEstimates([{ id: "a", text: "x y" }])[0]).toMatchObject({ id: "a", est_start: 0 });
    expect(withTimeEstimates([{ id: "a" }])[0]).toEqual({ id: "a" });
  });
});

describe("role guidance", () => {
  it("covers every role and is empty for free-form ids", () => {
    expect(Object.keys(ROLE_GUIDANCE)).toHaveLength(6);
    expect(roleGuidance("quiz")).toMatch(/pause_card/);
    expect(roleGuidance("payoff")).toBe("");
  });
  it("is injected into the pick prompt only when given", () => {
    const b = { id: "x", text: "t" };
    expect(pickMessages(b, ["chart"])[0]!.content).not.toMatch(/Role /);
    expect(pickMessages(b, ["chart"], undefined, null, roleGuidance("reveal"))[0]!.content).toMatch(/Role reveal/);
  });
});

describe("loop overlay", () => {
  const sc = (beat: string, startMs: number) => ({ beat, startMs, durationMs: 2000 });
  it("last 12 frames, opacity 0 to 1", () => {
    const o = loopOverlay([sc("hook", 0), sc("loop", 2000)], 30);
    expect(o).toEqual({ from: 120 - 12, duration: 12 });
    expect(loopOpacity(0)).toBe(0);
    expect(loopOpacity(11)).toBe(1);
  });
  it("skipped without loop beat or with one scene", () => {
    expect(loopOverlay([sc("hook", 0), sc("reveal", 2000)], 30)).toBeNull();
    expect(loopOverlay([sc("loop", 0)], 30)).toBeNull();
  });
});

describe("tail trim", () => {
  const v = validateScenes({ version: 1, scenes: [{ id: "s1", beat: "b1", kind: "terminal", startMs: 0, durationMs: 3000, lines: [{ text: "ls" }] }] });
  it("never longer than 0.6 s after narration", () => {
    if (!v.ok) throw new Error("bad");
    const w = [{ startS: 0, endS: 3 }];
    const r = retimeScenes(v.doc, { words: w, beats: [{ id: "b1", text: "x" }], narrationDurationS: 3, tailMs: 5000 });
    expect(r.ok && r.doc.scenes[0]!.durationMs).toBe(3000 + MAX_TAIL_MS);
    const d = retimeScenes(v.doc, { words: w, beats: [{ id: "b1", text: "x" }], narrationDurationS: 3 });
    expect(d.ok && d.doc.scenes[0]!.durationMs).toBe(3400);
  });
});

describe("role warnings in slideshowRisk", () => {
  const s = (beat: string, kind: string) => ({ beat, kind });
  it("warn on a quiz that is not a pause card, a twist that repeats, a loop that does not match", () => {
    const w = slideshowRisk([s("hook", "chart"), s("quiz", "chart"), s("reveal", "network"), s("twist", "network"), s("loop", "orbit")]).join(" ");
    expect(w).toMatch(/quiz/);
    expect(w).toMatch(/twist/);
    expect(w).toMatch(/loop/);
    expect(slideshowRisk([s("hook", "chart"), s("quiz", "pause_card"), s("twist", "orbit"), s("loop", "chart")]).join(" ")).not.toMatch(/quiz|twist|loop/);
  });
});
