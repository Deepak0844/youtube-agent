import { describe, expect, it, vi } from "vitest";
import {
  runAgent,
  sanitizeToolOutput,
  TOOL_OUTPUT_MAX_BYTES,
  type AgentStepStore,
  type ModelStep,
  type PayStep,
  type StepResult,
} from "@/server/core/agent-loop";
import { LeaseLostError } from "@/server/core/paid-call";

const price = { inputPerMTokMicro: 1_000_000, outputPerMTokMicro: 5_000_000 };
const claim = { stageRunId: "run1", fence: 1, workerId: "w" };
const res = (text: string, calls: StepResult["toolCalls"] = []): StepResult => ({
  text,
  toolCalls: calls,
  usage: { inputTokens: 100, outputTokens: 20 },
});

// In-memory store with the same contract as the Postgres one: first write per (step, call id) wins.
function memStore(opts: { failSaveOnce?: (callId: string) => boolean; stale?: boolean } = {}) {
  const rows = new Map<string, string>();
  let failed = false;
  const store: AgentStepStore = {
    loadOutputs: async (i) => {
      const m = new Map<string, string>();
      for (const [k, v] of rows) if (k.startsWith(`${i}:`)) m.set(k.slice(String(i).length + 1), v);
      return m.size ? m : null;
    },
    saveOutputs: async (_c, i, outs) => {
      if (opts.stale) return false;
      for (const o of outs) {
        if (!failed && opts.failSaveOnce?.(o.toolCallId)) {
          failed = true;
          throw new Error("crash");
        }
        if (!rows.has(`${i}:${o.toolCallId}`)) rows.set(`${i}:${o.toolCallId}`, o.output);
      }
      return true;
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
    // The secret-shaped text is what the model sees in both runs (redacted before it is used or stored).
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
    const step = vi.fn<ModelStep>()
      .mockResolvedValueOnce(res("", [{ id: "h", name: "big", args: {} }]))
      .mockResolvedValueOnce(res("ok"));
    const { store, rows } = memStore();
    await runAgent({
      paid: replayingPaid(new Map()), price, budgetScopes: ["run"], maxOutputTokens: 10, maxSteps: 3, step, store, claim,
      tools: [{ name: "big", run: async () => huge }], messages: [{ role: "user", content: "x" }],
    });
    for (const v of rows.values()) expect(Buffer.byteLength(v)).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES);
  });
});
