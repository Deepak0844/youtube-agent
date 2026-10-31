import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import type { StepResult } from "@/server/core/agent-loop";
import type { ModelRow } from "@/server/core/llm-catalog";
import { BudgetRefusedError, KnownFailure, NeedsDecisionError } from "@/server/core/paid-call";
import { beatDurationMs, buildSceneDoc } from "@/server/core/scene-build";
import { fakeModelStep } from "@/server/llm/fake-step";
import { createLlmClient, type LlmStageContext } from "@/server/llm/client";

const ROW: ModelRow = {
  id: "00000000-0000-4000-8000-0000000000aa",
  provider: "anthropic",
  modelId: "m",
  label: "Fake",
  baseUrl: null,
  prices: { inputPerMTokMicro: 1_000_000, outputPerMTokMicro: 1_000_000 },
  isFree: false,
  capabilities: { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 },
  enabled: true,
  endpointKind: "hosted",
};
const term = { id: "s1", kind: "terminal", beat: "b1", startMs: 0, durationMs: 3000, lines: [{ text: "ls" }] };
const doc = (scene: object) => JSON.stringify({ version: 1, scenes: [scene] });
const ans = (text: string): StepResult => ({ text, toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } });
const pick = (kind = "terminal") => ans(JSON.stringify({ kind }));

// Stand-in for ctx.paid: numbers calls like the real one; a "resumed" ctx on the same ledger gets finished results back free.
function harness(script: Array<StepResult | Error>, opts: { ledger?: { done: Map<number, unknown>; providerCalls: number }; refuseAfter?: number } = {}) {
  const ledger = opts.ledger ?? { done: new Map<number, unknown>(), providerCalls: 0 };
  const step = fakeModelStep({ script });
  let n = 0;
  const ctx: LlmStageContext = {
    signal: new AbortController().signal,
    async paid(s, call) {
      const i = n++;
      if (ledger.done.has(i)) return ledger.done.get(i) as never;
      if (opts.refuseAfter !== undefined && i >= opts.refuseAfter) throw new BudgetRefusedError(`k${i}`);
      ledger.providerCalls++;
      const out = await call(`k${i}`, new AbortController().signal);
      ledger.done.set(i, JSON.parse(JSON.stringify(out.result)));
      return out.result;
    },
  };
  const llm = createLlmClient({
    db: undefined as never,
    catalog: { route: async () => ROW, localServices: async () => [] },
    getKey: async () => null,
    buildModel: () => ({}) as LanguageModel,
    budgetScopes: () => ["video:x"],
    makeStep: () => step,
  });
  const prompts: string[] = [];
  const ask = async (messages: Parameters<typeof llm.agent>[1]["messages"]) => {
    prompts.push(JSON.stringify(messages));
    return (await llm.agent(ctx, { stage: "build_scene_kit", tools: [], messages, maxSteps: 1, maxOutputTokens: 1500 })).text;
  };
  return { ask, ledger, prompts };
}
const beats = [{ id: "b1", text: "List the files." }, { id: "b2", text: "Print hello." }];

const ken = { id: "s1", kind: "story_kenburns", beat: "b1", startMs: 0, durationMs: 3000, image: "img_9" };

describe("buildSceneDoc", () => {
  it("all valid first try: ids, beats and times come from the beats; each beat is two small calls", async () => {
    const h = harness([pick(), ans(doc({ ...term, id: "zzz", beat: "wrong", startMs: 999, durationMs: 700 })), pick(), ans(doc(term))]);
    const d = await buildSceneDoc(beats, h.ask);
    expect(d.scenes.map((s) => [s.id, s.beat, s.startMs, s.durationMs])).toEqual([
      ["s1", "b1", 0, beatDurationMs(beats[0]!.text)],
      ["s2", "b2", beatDurationMs(beats[0]!.text), beatDurationMs(beats[1]!.text)],
    ]);
    expect(h.ledger.providerCalls).toBe(4);
  });

  it("the fill prompt carries only the picked kind, not all kinds", async () => {
    const h = harness([pick(), ans(doc(term))]);
    await buildSceneDoc([beats[0]!], h.ask);
    expect(h.prompts[1]).toContain('kind \\"terminal\\"');
    expect(h.prompts[1]).not.toContain("chat_thread");
    expect(h.prompts[1]!.length).toBeLessThan(h.prompts[0]!.length * 4);
  });

  it("invalid then fixed on retry: errors are fed back", async () => {
    const h = harness([pick(), ans("not json"), ans(doc(term))]);
    const d = await buildSceneDoc([beats[0]!], h.ask);
    expect(d.scenes).toHaveLength(1);
    expect(h.prompts[2]).toContain("not valid JSON");
    expect(h.ledger.providerCalls).toBe(3);
  });

  it("CTA wording on screen is a rule problem: fed back and fixed on retry", async () => {
    const cta = { ...term, lines: [{ text: "like and subscribe" }] };
    const h = harness([pick(), ans(doc(cta)), ans(doc(term))]);
    const d = await buildSceneDoc([beats[0]!], h.ask);
    expect(d.scenes).toHaveLength(1);
    expect(h.prompts[2]).toContain("banned phrase");
  });

  it("the same rule error twice stops the retries", async () => {
    const cta = { ...term, lines: [{ text: "subscribe" }] };
    const h = harness([pick(), ans(doc(cta)), ans(doc(cta))]);
    await expect(buildSceneDoc([beats[0]!], h.ask)).rejects.toThrow(/beat 'b1'.*banned phrase/);
    expect(h.ledger.providerCalls).toBe(3);
  });

  it("the same error twice stops the retries and fails with beat id and errors", async () => {
    const h = harness([pick(), ans("nope")]);
    const e = await buildSceneDoc(beats, h.ask).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(KnownFailure);
    expect((e as Error).message).toMatch(/beat 'b1'.*not valid JSON/);
    expect(h.ledger.providerCalls).toBe(3); // pick + 2 fills, not 4
  });

  it("different errors each time stop at the cap of 2 retries", async () => {
    const h = harness([pick(), ans("nope"), ans(JSON.stringify({ version: 1, scenes: [] })), ans(JSON.stringify({ version: 2, scenes: [] }))]);
    await expect(buildSceneDoc(beats, h.ask)).rejects.toThrow(/beat 'b1'/);
    expect(h.ledger.providerCalls).toBe(4);
  });

  it("a refused (over-cap) call surfaces and no document is made", async () => {
    const h = harness([pick(), ans(doc(term))], { refuseAfter: 1 });
    await expect(buildSceneDoc(beats, h.ask)).rejects.toBeInstanceOf(BudgetRefusedError);
  });

  it("an asset id outside the allowed list is rejected; an allowed one passes", async () => {
    const bad = harness([pick("story_kenburns"), ans(doc(ken)), ans(doc({ ...ken, image: "img_1" }))]);
    const d = await buildSceneDoc([beats[0]!], bad.ask, { assets: ["img_1"] });
    expect(bad.prompts[2]).toContain("'img_9' does not exist");
    expect(d.scenes[0]).toMatchObject({ kind: "story_kenburns", image: "img_1" });
  });

  it("with no assets, image kinds are not offered and cannot be picked", async () => {
    const h = harness([pick("story_kenburns"), pick(), ans(doc(term))]);
    await buildSceneDoc([beats[0]!], h.ask);
    expect(h.prompts[0]).not.toContain("story_kenburns");
    expect(h.prompts[0]).toContain("terminal");
    expect(h.prompts[1]).toContain("kind must be one of");
  });

  it("replay after a crash does not pay again", async () => {
    const first = harness([pick(), ans(doc(term)), pick(), ans(doc(term))]);
    await buildSceneDoc(beats, first.ask);
    expect(first.ledger.providerCalls).toBe(4);
    const again = harness([new Error("provider must not be called")], { ledger: first.ledger });
    expect((await buildSceneDoc(beats, again.ask)).scenes).toHaveLength(2);
    expect(first.ledger.providerCalls).toBe(4);
  });

  it("free checks run before any paid call: bad id on beat 5, or more than 40 beats", async () => {
    const h = harness([pick(), ans(doc(term))]);
    const five = Array.from({ length: 5 }, (_, n) => ({ id: n === 4 ? "Bad Id!" : `b${n + 1}`, text: "x" }));
    await expect(buildSceneDoc(five, h.ask)).rejects.toThrow(/Bad Id/);
    const many = Array.from({ length: 41 }, (_, n) => ({ id: `b${n + 1}`, text: "x" }));
    await expect(buildSceneDoc(many, h.ask)).rejects.toThrow(/at most 40/);
    expect(h.ledger.providerCalls).toBe(0);
  });

  it("an unclear outcome (NeedsDecisionError) goes up untouched and is not retried", async () => {
    let calls = 0;
    const ask = async (): Promise<string> => {
      calls++;
      throw new NeedsDecisionError("run", "k1", 5);
    };
    await expect(buildSceneDoc(beats, ask)).rejects.toBeInstanceOf(NeedsDecisionError);
    expect(calls).toBe(1);
  });

  it("a bad kind pick is retried; the same bad pick twice stops", async () => {
    const ok = harness([pick("bogus"), pick(), ans(doc(term))]);
    expect((await buildSceneDoc([beats[0]!], ok.ask)).scenes).toHaveLength(1);
    expect(ok.prompts[1]).toContain("kind must be one of");
    const stuck = harness([pick("bogus")]);
    await expect(buildSceneDoc([beats[0]!], stuck.ask)).rejects.toThrow(/beat 'b1'.*kind must be one of/);
    expect(stuck.ledger.providerCalls).toBe(2);
  });

  it("a fill of another kind, or with more than one scene, is rejected", async () => {
    const other = harness([pick("browser"), ans(doc(term))]);
    await expect(buildSceneDoc([beats[0]!], other.ask)).rejects.toThrow(/must be 'browser'/);
    const two = harness([pick(), ans(JSON.stringify({ version: 1, scenes: [term, { ...term, id: "s2", startMs: 3000 }] }))]);
    await expect(buildSceneDoc([beats[0]!], two.ask)).rejects.toThrow(/exactly 1 scene/);
  });

  it("a code-fenced answer is accepted", async () => {
    const h = harness([pick(), ans("```json\n" + doc(term) + "\n```")]);
    expect((await buildSceneDoc([beats[0]!], h.ask)).scenes).toHaveLength(1);
  });

  it("an asset id nested in collage tiles is checked against the allow-list", async () => {
    const tile = (asset: string) => ({ asset });
    const col = (a: string, b: string) => doc({ id: "s1", kind: "collage", beat: "b1", startMs: 0, durationMs: 3000, layout: "grid2", tiles: [tile(a), tile(b)] });
    const h = harness([pick("collage"), ans(col("img_1", "img_9")), ans(col("img_1", "img_2"))]);
    const d = await buildSceneDoc([beats[0]!], h.ask, { assets: ["img_1", "img_2"] });
    expect(h.prompts[2]).toContain("'img_9' does not exist");
    expect(d.scenes[0]!.kind).toBe("collage");
  });
});
