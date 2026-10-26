import { describe, expect, it, vi } from "vitest";
import { MaxStepsError, runAgent, type ModelStep, type StepResult } from "@/server/core/agent-loop";
import type { PaidCallPorts } from "@/server/core/paid-call";
import { UnpricedCallError } from "@/server/core/spend";

const claim = { stageRunId: "run1" } as never;
const price = { inputPerMTokMicro: 1_000_000, outputPerMTokMicro: 5_000_000 };

function ports(refuse?: "cap"): PaidCallPorts & { reserved: number[]; settled: number[] } {
  const reserved: number[] = [];
  const settled: number[] = [];
  return {
    reserved,
    settled,
    reserve: vi.fn(async (_c, a) => {
      if (refuse) return { kind: "refused", reason: refuse };
      reserved.push(a.reserveMicroUsd);
      return { kind: "new", intentId: `i${reserved.length}` };
    }),
    settle: vi.fn(async (_id, a) => void settled.push(a.actualMicroUsd)),
    failKnown: vi.fn(async () => {}),
    markUnknown: vi.fn(async () => {}),
    markStageNeedsDecision: vi.fn(async () => {}),
    warn: vi.fn(),
  } as never;
}
const res = (text: string, calls: StepResult["toolCalls"] = []): StepResult => ({
  text,
  toolCalls: calls,
  usage: { inputTokens: 100, outputTokens: 20 },
});
const base = (step: ModelStep, p = ports()) => ({
  claim, ports: p, price, budgetScopes: ["run"], maxOutputTokens: 1000, maxSteps: 4, step,
  tools: [{ name: "echo", run: async (a: unknown) => `got ${JSON.stringify(a)}` }],
  messages: [{ role: "user" as const, content: "hi" }],
});

describe("agent loop", () => {
  it("unpriced_model_is_refused_before_reserve_or_model_call", async () => {
    const step = vi.fn();
    const p = ports();
    await expect(runAgent({ ...base(step, p), price: undefined })).rejects.toBeInstanceOf(UnpricedCallError);
    expect(step).not.toHaveBeenCalled();
    expect(p.reserve).not.toHaveBeenCalled();
  });
  it("cap_refusal_never_calls_the_model", async () => {
    const step = vi.fn();
    await expect(runAgent(base(step, ports("cap")))).rejects.toThrow();
    expect(step).not.toHaveBeenCalled();
  });
  it("reserves_worst_case_then_settles_actual_and_runs_tools", async () => {
    const p = ports();
    const step = vi.fn<ModelStep>()
      .mockResolvedValueOnce(res("", [{ id: "t1", name: "echo", args: { a: 1 } }]))
      .mockResolvedValueOnce(res("done"));
    const out = await runAgent(base(step, p));
    expect(out.text).toBe("done");
    expect(out.steps).toBe(2);
    expect(p.reserved).toHaveLength(2);
    expect(p.reserved[0]).toBeGreaterThanOrEqual(5000); // 1000 output tokens at 5 USD/M
    expect(p.settled[0]).toBe(100 + 100); // 100 in * 1 + 20 out * 5 per M... = 200 micro
    expect(out.messages.some((m) => m.role === "tool" && m.content === 'got {"a":1}')).toBe(true);
  });
  it("unknown_tool_and_throwing_tool_become_error_text_not_crashes", async () => {
    const step = vi.fn<ModelStep>()
      .mockResolvedValueOnce(res("", [{ id: "a", name: "shell", args: {} }]))
      .mockResolvedValueOnce(res("ok"));
    const out = await runAgent(base(step));
    expect(out.messages.find((m) => m.toolCallId === "a")?.content).toMatch(/unknown tool/);
  });
  it("stops_at_max_steps", async () => {
    const step = vi.fn<ModelStep>().mockResolvedValue(res("", [{ id: "x", name: "echo", args: {} }]));
    await expect(runAgent({ ...base(step), maxSteps: 2 })).rejects.toBeInstanceOf(MaxStepsError);
    expect(step).toHaveBeenCalledTimes(2);
  });
  it("abort_signal_stops_before_next_call", async () => {
    const ac = new AbortController();
    ac.abort();
    const step = vi.fn();
    await expect(runAgent({ ...base(step), signal: ac.signal })).rejects.toThrow();
    expect(step).not.toHaveBeenCalled();
  });
});
