import { describe, expect, it, vi } from "vitest";
import {
  hashToolArgs,
  runAgent,
  type AgentOptions,
  sanitizeToolOutput,
  TOOL_OUTPUT_MAX_BYTES,
  type AgentStepStore,
  type ModelStep,
  type PayStep,
  type StepResult,
  type StoredToolOutput,
} from "@/server/core/agent-loop";
import { LeaseLostError } from "@/server/core/paid-call";

const price = { inputPerMTokMicro: 1_000_000, outputPerMTokMicro: 5_000_000 };
const claim = { stageRunId: "run1", fence: 1, workerId: "w" };
const res = (text: string, calls: StepResult["toolCalls"] = []): StepResult => ({
  text,
  toolCalls: calls,
  usage: { inputTokens: 100, outputTokens: 20 },
});

// In-memory store with the same contract as the Postgres one: keyed by (step, position), first write wins.
function memStore(opts: { failSaveOnce?: (callId: string) => boolean; stale?: boolean } = {}) {
  const rows = new Map<string, StoredToolOutput>();
  let failed = false;
  const view = (i: number) => {
    const m = new Map<number, StoredToolOutput>();
    for (const [k, v] of rows) {
      const [step, idx] = k.split(":").map(Number);
      if (step === i) m.set(idx!, v);
    }
    return m;
  };
  const store: AgentStepStore = {
    loadOutputs: async (i) => {
      const m = view(i);
      return m.size ? m : null;
    },
    saveOutputs: async (_c, i, outs) => {
      if (opts.stale) return null;
      for (const { index, ...o } of outs) {
        if (!failed && opts.failSaveOnce?.(o.toolCallId)) {
          failed = true;
          throw new Error("crash");
        }
        if (!rows.has(`${i}:${index}`)) rows.set(`${i}:${index}`, o);
      }
      return view(i);
    },
  };
  return { store, rows };
}

// A stage's `paid`: numbers steps from 0 on every run and replays a step that already settled (what ctx.paid does).
function replayingPaid(done: Map<number, StepResult>) {
  let n = 0;
  const pay: PayStep = async (_s, call) => {
    const i = n++;
    const hit = done.get(i);
    if (hit) return hit as never;
    const out = await call(`k${i}`, new AbortController().signal);
    done.set(i, out.result as StepResult);
    return out.result;
  };
  return pay;
}

function setup() {
  const script = [
    res("", [
      { id: "a", name: "search", args: { q: "x" } },
      { id: "b", name: "fetch", args: { u: "y" } },
    ]),
    res("final"),
  ];
  const model = { calls: 0 };
  const step: ModelStep = async () => script[model.calls++]!;
  const runs = { search: 0, fetch: 0 };
  const tools = [
    { name: "search", run: async () => (runs.search++, "sk-abcdefghij1234 result a") },
    { name: "fetch", run: async () => (runs.fetch++, "page b") },
  ];
  const opts = (pay: PayStep, store: AgentStepStore) => ({
    paid: pay, price, budgetScopes: ["run"], maxOutputTokens: 1000, maxSteps: 4,
    step, tools, messages: [{ role: "user" as const, content: "go" }], store, claim,
  });
  return { model, runs, opts };
}

const mini = (over: Partial<AgentOptions> & { step: ModelStep; tools: AgentOptions["tools"] }): AgentOptions => ({
  price, budgetScopes: ["run"], maxOutputTokens: 10, maxSteps: 3, claim, messages: [{ role: "user" as const, content: "x" }], ...over,
});

describe("agent checkpoints", () => {
  it("resumed_run_replays_done_steps_with_zero_model_calls_and_zero_tool_calls", async () => {
    const { model, runs, opts } = setup();
    const done = new Map<number, StepResult>();
    const { store } = memStore();
    await runAgent(opts(replayingPaid(done), store));
    expect(model.calls).toBe(2);
    expect(runs).toEqual({ search: 1, fetch: 1 });
    // The whole run again, as after a crash after the last save: nothing is repeated.
    await runAgent(opts(replayingPaid(done), store));
    expect(model.calls).toBe(2);
    expect(runs).toEqual({ search: 1, fetch: 1 });
  });

  it("crash_between_model_settle_and_tool_save_reruns_only_that_tool", async () => {
    const { model, runs, opts } = setup();
    const done = new Map<number, StepResult>();
    const { store } = memStore({ failSaveOnce: (id) => id === "b" });
    await expect(runAgent(opts(replayingPaid(done), store))).rejects.toThrow("crash");
    expect(model.calls).toBe(1);
    expect(runs).toEqual({ search: 1, fetch: 1 });
    const out = await runAgent(opts(replayingPaid(done), store));
    expect(out.text).toBe("final");
    expect(model.calls).toBe(2); // step 0 replayed, only the last step is new
    expect(runs).toEqual({ search: 1, fetch: 2 }); // search came from the store, fetch (never saved) ran again
  });

  it("stale_fence_cannot_save_outputs", async () => {
    const { runs, opts } = setup();
    const { store, rows } = memStore({ stale: true });
    await expect(runAgent(opts(replayingPaid(new Map()), store))).rejects.toBeInstanceOf(LeaseLostError);
    expect(rows.size).toBe(0);
    expect(runs.fetch).toBe(0); // stopped at the first refused save; no further tools
  });

  it("messages_after_resume_are_identical_to_the_original_run", async () => {
    const { opts } = setup();
    const done = new Map<number, StepResult>();
    const { store } = memStore();
    const first = await runAgent(opts(replayingPaid(done), store));
    const second = await runAgent(opts(replayingPaid(done), store));
    expect(second.messages).toEqual(first.messages);
    expect(second.spentMicroUsd).toBe(first.spentMicroUsd);
    // A provider-key shape is redacted for the model, in both runs.
    expect(first.messages.find((m) => m.toolCallId === "a")?.content).not.toContain("sk-abcdefghij1234");
  });

  it("tool_output_with_nul_or_huge_text_is_stored_safely", async () => {
    const huge = "é".repeat(40_000) + "\u0000tail\ud800";
    const s = sanitizeToolOutput(huge);
    expect(s).not.toContain("\u0000");
    expect(s.isWellFormed()).toBe(true);
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES);
    expect(sanitizeToolOutput(s)).toBe(s); // idempotent: the store may sanitise again
    expect(sanitizeToolOutput("a\u0000b")).toBe("ab");
    const json = JSON.stringify({ items: Array.from({ length: 3000 }, (_, i) => ({ i, url: `https://x.example/p/${i}-abc` })) });
    const j = sanitizeToolOutput(json);
    expect(Buffer.byteLength(j)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES);
    expect(sanitizeToolOutput(j)).toBe(j);
    const step = vi.fn<ModelStep>()
      .mockResolvedValueOnce(res("", [{ id: "h", name: "big", args: {} }]))
      .mockResolvedValueOnce(res("ok"));
    const { store, rows } = memStore();
    await runAgent(mini({ paid: replayingPaid(new Map()), step, store, tools: [{ name: "big", run: async () => huge }] }));
    for (const v of rows.values()) expect(Buffer.byteLength(v.output)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES);
  });

  it("the_model_sees_the_same_tool_text_with_and_without_a_store_and_urls_survive", async () => {
    const url = "https://en.wikipedia.org/wiki/Special:Search/the-quick-brown-fox-jumps-over_the-lazy-dog?x=1";
    const run = async (withStore: boolean) => {
      const step = vi.fn<ModelStep>()
        .mockResolvedValueOnce(res("", [{ id: "u", name: "t", args: {} }]))
        .mockResolvedValueOnce(res("ok"));
      return runAgent(
        mini({
          paid: replayingPaid(new Map()), step, ...(withStore ? { store: memStore().store } : {}),
          tools: [{ name: "t", run: async () => `1. ${url}\n2. https://a.example/${"b".repeat(60)}-c/d` }],
        }),
      );
    };
    const [a, b] = [await run(true), await run(false)];
    expect(a.messages).toEqual(b.messages);
    expect(a.messages.find((m) => m.role === "tool")?.content).toContain(url);
  });

  it("two_runs_in_one_stage_do_not_replay_each_others_outputs", async () => {
    const { store } = memStore();
    const mk = (q: string, ordinal: number) => {
      const step = vi.fn<ModelStep>()
        .mockResolvedValueOnce(res("", [{ id: "call_0", name: "search", args: { q } }]))
        .mockResolvedValueOnce(res("done"));
      const runs = { n: 0 };
      return {
        runs,
        go: () =>
          runAgent(
            mini({
              paid: replayingPaid(new Map()), step, store, runOrdinal: ordinal,
              tools: [{ name: "search", run: async () => (runs.n++, `result for ${q}`) }],
            }),
          ),
      };
    };
    await mk("alpha", 0).go();
    // Same provider id call_0 and same ordinal, different args: the args hash stops the replay.
    const clash = mk("beta", 0);
    const out = await clash.go();
    expect(clash.runs.n).toBe(1);
    expect(out.messages.find((m) => m.role === "tool")?.content).toBe("result for beta");
    // A distinct ordinal gets its own slots even with identical args.
    const second = mk("alpha", 1);
    await second.go();
    expect(second.runs.n).toBe(1);
  });

  it("duplicate_empty_long_and_nul_tool_call_ids_are_keyed_by_position_and_never_throw", async () => {
    const ids = ["dup", "dup", "", "x".repeat(300), "n\u0000ul"];
    const seen: number[] = [];
    const { store, rows } = memStore();
    const done = new Map<number, StepResult>();
    const o = () =>
      mini({
        paid: replayingPaid(done), store,
        step: vi.fn<ModelStep>()
          .mockResolvedValueOnce(res("", ids.map((id, i) => ({ id, name: "t", args: { i } }))))
          .mockResolvedValueOnce(res("ok")),
        tools: [{ name: "t", run: async (a: unknown) => (seen.push((a as { i: number }).i), `out${(a as { i: number }).i}`) }],
      });
    const first = await runAgent(o());
    expect(rows.size).toBe(5);
    expect(first.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["out0", "out1", "out2", "out3", "out4"]);
    const second = await runAgent(o());
    expect(seen).toEqual([0, 1, 2, 3, 4]); // nothing ran twice
    expect(second.messages).toEqual(first.messages);
  });

  it("a_tool_error_is_not_checkpointed_and_is_retried_on_resume", async () => {
    let n = 0;
    const done = new Map<number, StepResult>();
    const { store, rows } = memStore();
    const o = () =>
      mini({
        paid: replayingPaid(done), store,
        step: vi.fn<ModelStep>().mockResolvedValueOnce(res("", [{ id: "e", name: "t", args: {} }])).mockResolvedValueOnce(res("ok")),
        tools: [{ name: "t", run: async () => { if (n++ === 0) throw new Error("boom"); return "fine"; } }],
      });
    const first = await runAgent(o());
    expect(first.messages.find((m) => m.role === "tool")?.content).toBe("error: boom");
    expect(rows.size).toBe(0);
    const second = await runAgent(o());
    expect(second.messages.find((m) => m.role === "tool")?.content).toBe("fine");
    expect(rows.size).toBe(1);
  });

  it("an_abort_during_a_tool_stops_the_run_and_saves_nothing", async () => {
    const ac = new AbortController();
    const { store, rows } = memStore();
    const step = vi.fn<ModelStep>().mockResolvedValueOnce(res("", [{ id: "a", name: "t", args: {} }]));
    await expect(
      runAgent(
        mini({
          paid: replayingPaid(new Map()), step, store, signal: ac.signal,
          tools: [{ name: "t", run: async () => { ac.abort(); throw new Error("aborted"); } }],
        }),
      ),
    ).rejects.toThrow();
    expect(rows.size).toBe(0);
  });

  it("the_stored_value_wins_over_a_rerun_so_live_equals_replay", async () => {
    const { store, rows } = memStore();
    rows.set("0:0", { toolCallId: "a", toolName: "t", argsHash: hashToolArgs({}), output: "stored" });
    const step = vi.fn<ModelStep>()
      .mockResolvedValueOnce(res("", [{ id: "a", name: "t", args: {} }]))
      .mockResolvedValueOnce(res("ok"));
    // A loader that misses (as after a lost race) while another writer already stored the row.
    const racing: AgentStepStore = { loadOutputs: async () => null, saveOutputs: store.saveOutputs };
    const out = await runAgent(
      mini({ paid: replayingPaid(new Map()), step, store: racing, tools: [{ name: "t", run: async () => "fresh" }] }),
    );
    expect(out.messages.find((m) => m.role === "tool")?.content).toBe("stored");
  });
});
