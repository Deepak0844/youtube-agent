import { describe, expect, it } from "vitest";
import { describeSceneFormat, validateScenes } from "@/shared/scene";
import { BANNED_PHRASES, checkSceneRules, RULES, validateAndCheck } from "@/shared/scene/rules";
import { defaultTheme } from "../../../remotion/kit/theme";

const term = (o: object = {}) => ({ id: "s1", beat: "hook", kind: "terminal", startMs: 0, durationMs: 3000, lines: [{ text: "ls" }], ...o });
const doc = (...scenes: unknown[]) => ({ version: 1, scenes }) as never;
const codes = (d: unknown, opts?: object) => RULES.filter((r) => checkSceneRules(d as never, { ...opts, only: r.code } as never).length).map((r) => r.code);
const bad = (d: unknown, code: string, opts?: object) => expect(codes(d, opts)).toContain(code);
const good = (d: unknown, code: string, opts?: object) => expect(codes(d, opts)).not.toContain(code);

describe("schema tweaks", () => {
  it("chess accepts a full FEN and keeps placement only", () => {
    const r = validateScenes(doc({ id: "c", beat: "b", kind: "chess", startMs: 0, durationMs: 3000, position: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" }));
    expect(r.ok && (r.doc.scenes[0] as { position: string }).position).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR");
  });
  it("chess still rejects a bad placement", () => {
    expect(validateScenes(doc({ id: "c", beat: "b", kind: "chess", startMs: 0, durationMs: 3000, position: "zzz w - - 0 1" })).ok).toBe(false);
  });
  it("describe text states pause_card and network limits", () => {
    const t = describeSceneFormat();
    expect(t).toMatch(/2 to 4 options/);
    expect(t).toMatch(/packet label max 10 chars/);
  });
});

describe("rules", () => {
  it("banned phrases match the theme", () => expect([...BANNED_PHRASES]).toEqual([...defaultTheme.copy.bannedPhrases]));
  const beats = ["hook", "mid", "end"];
  it("beat-order", () => {
    good(doc(term(), term({ id: "s2", beat: "mid", startMs: 3000 })), "beat-order", { beats });
    bad(doc(term({ beat: "mid" }), term({ id: "s2", beat: "hook", startMs: 3000 })), "beat-order", { beats });
  });
  it("hook-first", () => {
    good(doc(term()), "hook-first", { beats });
    bad(doc(term({ beat: "mid" })), "hook-first", { beats });
  });
  it("beat-empty", () => {
    good(doc(term(), term({ id: "s2", beat: "mid" }), term({ id: "s3", beat: "end" })), "beat-empty", { beats });
    bad(doc(term()), "beat-empty", { beats });
  });
  it("beat-max-scenes", () => {
    const three = doc(term(), term({ id: "s2" }), term({ id: "s3" }));
    good(three, "beat-max-scenes", { maxScenesPerBeat: 3 });
    bad(three, "beat-max-scenes", { maxScenesPerBeat: 2 });
  });
  it("no-cta", () => {
    good(doc(term()), "no-cta");
    bad(doc(term({ lines: [{ text: "Like and Subscribe now" }] })), "no-cta");
  });
  it("frame0", () => {
    good(doc(term()), "frame0");
    bad(doc(term({ startMs: 500 })), "frame0");
    bad(doc(term({ lines: [{ text: "  " }] })), "frame0");
    bad(doc({ id: "c", beat: "hook", kind: "chat_thread", startMs: 0, durationMs: 3000, messages: [] }), "frame0");
  });
  it("text-total", () => {
    good(doc(term()), "text-total");
    const long = Array.from({ length: 8 }, () => ({ text: "x".repeat(50) }));
    bad(doc(term({ lines: long })), "text-total");
  });
  it("local-assets", () => {
    const s = { id: "k", beat: "hook", kind: "story_kenburns", startMs: 0, durationMs: 3000, image: "img_1" };
    good(doc(s), "local-assets", { assetIds: ["img_1"] });
    good(doc(s), "local-assets");
    bad(doc(s), "local-assets", { assetIds: ["img_2"] });
  });
  it("has-objects", () => {
    good(doc({ id: "n", beat: "hook", kind: "network", startMs: 0, durationMs: 3000, nodes: [{ id: "a" }, { id: "b" }], links: [] }), "has-objects");
    bad(doc({ id: "n", beat: "hook", kind: "network", startMs: 0, durationMs: 3000, nodes: [], links: [] }), "has-objects");
    bad(doc({ id: "d", beat: "hook", kind: "drawn_objects", startMs: 0, durationMs: 3000, objects: [] }), "has-objects");
  });
  it("has-asset", () => {
    good(doc({ id: "k", beat: "hook", kind: "stock_clip", startMs: 0, durationMs: 3000, asset: "a1" }), "has-asset");
    bad(doc({ id: "k", beat: "hook", kind: "stock_clip", startMs: 0, durationMs: 3000 }), "has-asset");
    bad(doc({ id: "k", beat: "hook", kind: "collage", startMs: 0, durationMs: 3000, tiles: [] }), "has-asset");
  });
  it("messages are plain text with a fix hint", () => {
    const m = checkSceneRules(doc(term({ startMs: 500 })));
    expect(m[0]).toMatch(/^scene 1: .*Fix:/);
  });
});

describe("validateAndCheck", () => {
  it("schema errors first, else rule errors, else ok", () => {
    expect(validateAndCheck({ version: 1, scenes: [] }).ok).toBe(false);
    const r = validateAndCheck(doc(term({ lines: [{ text: "subscribe" }] })));
    expect(r.ok === false && r.errors[0]).toMatch(/banned|subscribe/);
    expect(validateAndCheck(doc(term())).ok).toBe(true);
  });
});
