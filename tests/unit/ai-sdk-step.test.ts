import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAiSdkStep } from "@/server/llm/ai-sdk-step";

const usage = (i: number | undefined, o: number | undefined) => ({
  inputTokens: { total: i, noCache: i, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: o, text: o, reasoning: undefined },
});
const mk = (content: unknown[], u = usage(11, 7)) =>
  new MockLanguageModelV4({
    doGenerate: { content, finishReason: { unified: "stop", raw: "stop" }, usage: u, warnings: [] } as never,
  });

describe("ai-sdk step", () => {
  it("maps_text_tool_calls_and_usage", async () => {
    const model = mk([
      { type: "text", text: "thinking" },
      { type: "tool-call", toolCallId: "c1", toolName: "readFile", input: JSON.stringify({ path: "a" }) },
    ]);
    const step = createAiSdkStep(model, [{ name: "readFile", description: "r", inputSchema: { type: "object" } }], 100);
    const r = await step([{ role: "user", content: "go" }], "k");
    expect(r.text).toBe("thinking");
    expect(r.toolCalls).toEqual([{ id: "c1", name: "readFile", args: { path: "a" } }]);
    expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(100);
  });
  it("missing_usage_fails_closed", async () => {
    const step = createAiSdkStep(mk([{ type: "text", text: "x" }], usage(undefined, undefined)), [], 10);
    await expect(step([{ role: "user", content: "go" }], "k")).rejects.toThrow(/no token usage/);
  });
});
