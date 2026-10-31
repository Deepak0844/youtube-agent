import { describe, expect, it } from "vitest";
import { planAiSource, readRemembered, type SwitchInput } from "@/server/core/ai-source";
import type { ModelRow } from "@/server/core/llm-catalog";

const all = { structuredOutput: true, toolUse: true, vision: true, nativeWebSearch: true, contextWindow: 200000 };
const api: ModelRow = { id: "00000000-0000-4000-8000-0000000000a1", provider: "anthropic", modelId: "m", label: "Paid", baseUrl: null, prices: { inputPerMTokMicro: 1, outputPerMTokMicro: 1 }, isFree: false, capabilities: all, enabled: true, endpointKind: "hosted" };
const other: ModelRow = { ...api, id: "00000000-0000-4000-8000-0000000000a2", label: "Other" };
const cc: ModelRow = { id: "00000000-0000-4000-8000-0000000000c1", provider: "claude_code", modelId: "default", label: "Claude Code", baseUrl: null, prices: null, isFree: true, capabilities: { structuredOutput: true, toolUse: false, vision: false, nativeWebSearch: false, contextWindow: 200000 }, enabled: true, endpointKind: "local" };

const everyStageOnApi = { outline: api.id, draft: api.id, build_scene_kit: api.id, build_tsx: api.id, qa_vision: api.id, research: api.id, titles: api.id };
const base: SwitchInput = { on: true, routes: everyStageOnApi, models: [api, other, cc], local: [], previous: null, claudeCodeId: cc.id };

describe("AI source switch (pure)", () => {
  it("ON routes only the text stages Claude Code can do and remembers what they had", () => {
    const p = planAiSource(base);
    if (!p.ok) throw new Error(p.reason);
    expect(p.routes).toEqual({ ...everyStageOnApi, outline: cc.id, draft: cc.id, build_scene_kit: cc.id, titles: cc.id, comment_replies: cc.id });
    expect(p.previous).toEqual({ outline: api.id, draft: api.id, build_scene_kit: api.id, titles: api.id, comment_replies: null });
    const text = p.notes.join("\n");
    expect(text).toMatch(/Build, Remotion TSX stays on its current model: it needs tool use/);
    expect(text).toMatch(/QA, vision review stays on its current model: it needs image input/);
    expect(text).toMatch(/Research and ideas stays on its current model/);
    expect(text).toMatch(/Draft: .*search-then-write/);
  });

  it("ON judges Claude Code as tool-free even if an older catalog row claims tools", () => {
    const p = planAiSource({ ...base, models: [api, other, { ...cc, capabilities: all }] });
    expect(p.ok && [p.routes.build_tsx, p.routes.research, p.routes.qa_vision]).toEqual([api.id, api.id, api.id]);
  });

  it("ON refuses when already on, without a Claude Code model, or when it is disabled", () => {
    expect(planAiSource({ ...base, previous: {} }).ok).toBe(false);
    expect(planAiSource({ ...base, claudeCodeId: undefined }).ok).toBe(false);
    expect(planAiSource({ ...base, claudeCodeId: api.id }).ok).toBe(false); // not a claude_code row
    expect(planAiSource({ ...base, models: [api, { ...cc, enabled: false }] }).ok).toBe(false);
  });

  it("OFF restores the remembered routes stage by stage, including 'no model'", () => {
    const on = planAiSource(base);
    if (!on.ok) throw new Error();
    const routes = Object.fromEntries(Object.entries(on.routes).filter(([, v]) => v !== null)) as Record<string, string>;
    const off = planAiSource({ ...base, on: false, routes, previous: on.previous });
    if (!off.ok) throw new Error(off.reason);
    expect(off.routes).toEqual({ ...everyStageOnApi, comment_replies: null });
    expect(off.previous).toBeNull();
    expect(off.notes).toEqual([]);
  });

  it("OFF leaves a stage the owner changed after switching, and unsets one whose model was deleted or disabled (and says so)", () => {
    const routes = { outline: cc.id, draft: other.id, build_scene_kit: cc.id, titles: cc.id };
    const previous = { outline: "00000000-0000-4000-8000-0000000000dd", draft: api.id, build_scene_kit: other.id, titles: api.id };
    const off = planAiSource({ ...base, on: false, routes, previous, models: [api, { ...other, enabled: false }, cc] });
    if (!off.ok) throw new Error(off.reason);
    expect(off.routes).toMatchObject({ outline: null, draft: other.id, build_scene_kit: null, titles: api.id });
    expect(off.notes.join("\n")).toMatch(/Outline: the model it used before was deleted, so it is now unset/);
    expect(off.notes.join("\n")).toMatch(/Draft keeps the model you chose/);
    expect(off.notes.join("\n")).toMatch(/Build, scene kit: the model it used before \(Other\) is disabled/);
  });

  it("OFF refuses when the switch is not on and ignores unknown stages in the remembered set", () => {
    expect(planAiSource({ ...base, on: false }).ok).toBe(false);
    const off = planAiSource({ ...base, on: false, routes: {}, previous: { nope: api.id } });
    expect(off.ok && Object.values(off.routes).every((v) => v === null)).toBe(true);
  });

  it("OFF unsets every stage still on Claude Code, including one routed there by hand before ON, and says so", () => {
    const routes = { outline: cc.id, titles: cc.id, draft: cc.id };
    const previous = { outline: cc.id, draft: api.id }; // outline was on Claude Code by hand; titles was never remembered
    const off = planAiSource({ ...base, on: false, routes, previous });
    if (!off.ok) throw new Error(off.reason);
    expect(off.routes).toMatchObject({ outline: null, titles: null, draft: api.id });
    const text = off.notes.join("\n");
    expect(text).toMatch(/Outline was on Claude Code, which is now off, so it is unset/);
    expect(text).toMatch(/Titles and insights was on Claude Code/);
  });

  it("OFF ignores prototype-looking stage names in a hostile remembered set", () => {
    const hostile = JSON.parse(`{"constructor":"${api.id}","__proto__":"${api.id}","outline":null}`) as Record<string, string | null>;
    const off = planAiSource({ ...base, on: false, routes: { outline: cc.id }, previous: hostile });
    if (!off.ok) throw new Error(off.reason);
    expect(Object.keys(off.routes).sort()).toEqual(["build_scene_kit", "build_tsx", "comment_replies", "draft", "outline", "qa_vision", "research", "titles"]);
    expect(off.routes.outline).toBeNull();
  });
});

describe("readRemembered", () => {
  it("anything that is not a valid remembered set means 'no previous routes'", () => {
    for (const v of [null, undefined, 5, "x", [], [api.id], { outline: "not-a-uuid" }, { "Bad Key": null }]) expect(readRemembered(v), JSON.stringify(v)).toBeNull();
    expect(readRemembered({})).toEqual({});
    expect(readRemembered({ outline: api.id, titles: null })).toEqual({ outline: api.id, titles: null });
  });
});
