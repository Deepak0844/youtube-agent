import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDERS, type ModelRow } from "@/server/core/llm-catalog";
import { createAiSdkStep } from "@/server/llm/ai-sdk-step";
import { buildModel } from "@/server/llm/model-factory";

// One canned-response fixture per catalog provider, in the provider's documented wire format, run through the real factory and
// the real step adapter with only the network replaced. No network, no database.
const DIR = join(__dirname, "../fixtures/llm");
interface Fixture {
  provider: string;
  adapter: string;
  modelId: string;
  completion: unknown;
  toolCall: unknown;
  structured: unknown;
  noUsage: unknown;
}
const fixtures = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture);
const KEY = "sk-contract-test-key-0123456789";
const LOCAL = new Set(["ollama", "lmstudio"]);

function modelFor(fx: Fixture, payload: unknown) {
  const row: ModelRow = {
    id: "00000000-0000-4000-8000-000000000002",
    provider: fx.provider,
    modelId: fx.modelId,
    label: fx.provider,
    baseUrl: LOCAL.has(fx.provider) ? "http://localhost:11434/v1" : fx.provider === "custom" ? "https://llm.example.com/v1" : null,
    prices: null,
    isFree: false,
    capabilities: { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 8000 },
    enabled: true,
    endpointKind: LOCAL.has(fx.provider) ? "local" : "hosted",
  };
  const fetch = (async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
  const decls = [{ name: "webSearch", description: "search", inputSchema: { type: "object", properties: { query: { type: "string" } } } }];
  return createAiSdkStep(buildModel(row, async () => KEY, { localServices: [], fetch }), decls, 100);
}
const ask = [{ role: "user" as const, content: "go" }];

describe("model factory contract, one fixture per provider", () => {
  it("there is exactly one fixture per catalog provider", () => {
    expect(fixtures.map((f) => f.provider).sort()).toEqual(PROVIDERS.map((p) => p.id).sort());
  });
  describe.each(fixtures.map((f) => [f.provider, f] as const))("%s", (_name, fx) => {
    it("plain completion parses into text and token usage", async () => {
      const r = await modelFor(fx, fx.completion)(ask, "k");
      expect(r.text).toBe("Hello from the fixture.");
      expect(r.toolCalls).toEqual([]);
      expect(r.usage).toEqual({ inputTokens: 21, outputTokens: 9 });
    });
    it("tool call parses into a tool call with parsed arguments", async () => {
      const r = await modelFor(fx, fx.toolCall)(ask, "k");
      expect(r.toolCalls).toHaveLength(1);
      expect(r.toolCalls[0]).toMatchObject({ name: "webSearch", args: { query: "fixture" } });
      expect(r.usage).toEqual({ inputTokens: 21, outputTokens: 9 });
    });
    it("structured JSON answer comes back as text that parses", async () => {
      const r = await modelFor(fx, fx.structured)(ask, "k");
      expect(JSON.parse(r.text)).toEqual({ title: "Fixture", beats: ["a", "b"] });
    });
    it("usage_missing_from_a_response_fails_closed", async () => {
      // The Anthropic package rejects a body without usage on its own ("Invalid JSON response"); the others reach our rule.
      await expect(modelFor(fx, fx.noUsage)(ask, "k")).rejects.toThrow(fx.adapter === "anthropic" ? /Invalid JSON response/ : /no token usage/);
    });
  });
});
