import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { PROVIDERS, type ModelRow } from "@/server/core/llm-catalog";
import { createAiSdkStep } from "@/server/llm/ai-sdk-step";
import { buildModel } from "@/server/llm/model-factory";
import { PROVIDER_ENDPOINTS } from "@/server/llm/provider-endpoints";

const KEY = "sk-SECRET-KEY-VALUE-0123456789abcdef";
const caps = { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 };
const row = (o: Partial<ModelRow> = {}): ModelRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  provider: "openai",
  modelId: "m-1",
  label: "M",
  baseUrl: null,
  prices: { inputPerMTokMicro: 1, outputPerMTokMicro: 1 },
  isFree: false,
  capabilities: caps,
  enabled: true,
  endpointKind: "hosted",
  ...o,
});
const body = {
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "m-1",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};
const anthropicBody = { id: "m", type: "message", role: "assistant", model: "m-1", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 } };

interface Seen {
  url: string;
  headers: Headers;
}
function recorder(json: unknown) {
  const seen: Seen[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { seen, fetch };
}
const run = (model: ReturnType<typeof buildModel>) => createAiSdkStep(model, [], 50)([{ role: "user", content: "go" }], "k");
const keyFn = () => {
  const calls = { n: 0 };
  return { calls, getKey: async () => (calls.n++, KEY) };
};

describe("model factory", () => {
  it("anthropic_uses_the_native_adapter_the_rest_openai_compatible", async () => {
    const a = recorder(anthropicBody);
    await run(buildModel(row({ provider: "anthropic" }), keyFn().getKey, { localServices: [], fetch: a.fetch }));
    expect(a.seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(a.seen[0]!.headers.get("x-api-key")).toBe(KEY);
    for (const p of PROVIDERS.filter((x) => x.id !== "anthropic" && !x.needsBaseUrl)) {
      const o = recorder(body);
      await run(buildModel(row({ provider: p.id }), keyFn().getKey, { localServices: [], fetch: o.fetch }));
      expect(o.seen[0]!.url, p.id).toBe(`${PROVIDER_ENDPOINTS[p.id].baseUrl}/chat/completions`);
      expect(o.seen[0]!.headers.get("authorization"), p.id).toBe(`Bearer ${KEY}`);
    }
  });

  it("key is fetched lazily, once per call, never at build", async () => {
    const o = recorder(body);
    const k = keyFn();
    const m = buildModel(row(), k.getKey, { localServices: [], fetch: o.fetch });
    expect(k.calls.n).toBe(0);
    await run(m);
    expect(k.calls.n).toBe(1);
    await run(m);
    expect(k.calls.n).toBe(2);
  });

  it("key_is_not_present_in_the_returned_model_object_or_its_json", async () => {
    for (const provider of ["anthropic", "openai", "custom"]) {
      const o = recorder(provider === "anthropic" ? anthropicBody : body);
      const m = buildModel(row({ provider, baseUrl: provider === "custom" ? "https://llm.example.com/v1" : null }), keyFn().getKey, { localServices: [], fetch: o.fetch });
      const before = JSON.stringify(m) + inspect(m, { depth: 12, showHidden: true });
      await run(m);
      const after = JSON.stringify(m) + inspect(m, { depth: 12, showHidden: true });
      expect(before, provider).not.toContain(KEY);
      expect(after, provider).not.toContain(KEY);
    }
  });

  it("missing_key_is_a_plain_error", async () => {
    for (const [provider, label] of [["anthropic", "Anthropic"], ["openai", "OpenAI"], ["gemini", "Google Gemini"], ["groq", "Groq"]] as const) {
      const o = recorder(body);
      const m = buildModel(row({ provider }), async () => null, { localServices: [], fetch: o.fetch });
      await expect(run(m), provider).rejects.toThrow(`No key saved for ${label}`);
      expect(o.seen, `${provider}: nothing was sent`).toHaveLength(0);
    }
  });

  it("an empty or throwing key lookup sends nothing and does not leak", async () => {
    const o = recorder(body);
    await expect(run(buildModel(row(), async () => "", { localServices: [], fetch: o.fetch }))).rejects.toThrow("No key saved for OpenAI");
    await expect(run(buildModel(row(), async () => { throw new Error(`vault says ${KEY}`); }, { localServices: [], fetch: o.fetch }))).rejects.toThrow(/Could not read the key for OpenAI/);
    expect(o.seen).toHaveLength(0);
  });

  it("local providers need no key, never read it and send no auth header", async () => {
    for (const provider of ["ollama", "lmstudio"]) {
      const o = recorder(body);
      const k = keyFn();
      await run(buildModel(row({ provider, baseUrl: "http://localhost:11434/v1", endpointKind: "local" }), k.getKey, { localServices: [], fetch: o.fetch }));
      expect(k.calls.n, provider).toBe(0);
      expect(o.seen[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
      expect(o.seen[0]!.headers.get("authorization")).toBeNull();
    }
  });

  it("custom: local address needs no key; a hosted address needs one and must be https", async () => {
    const local = recorder(body);
    await run(buildModel(row({ provider: "custom", baseUrl: "http://localhost:1234/v1", endpointKind: "local" }), async () => null, { localServices: [], fetch: local.fetch }));
    expect(local.seen).toHaveLength(1);
    expect(local.seen[0]!.headers.get("authorization")).toBeNull();
    const hosted = recorder(body);
    const m = buildModel(row({ provider: "custom", baseUrl: "https://llm.example.com/v1" }), async () => null, { localServices: [], fetch: hosted.fetch });
    await expect(run(m)).rejects.toThrow("No key saved for Custom OpenAI-compatible");
    expect(() => buildModel(row({ provider: "custom", baseUrl: "http://llm.example.com/v1" }), keyFn().getKey, { localServices: [] })).toThrow(/https/);
  });

  it("local_model_cannot_point_at_an_own_service", () => {
    for (const url of ["http://localhost:5432/v1", "http://127.0.0.1:6379", "http://[::1]:8888/v1", "http://127.0.0.2:3128", "http://2130706433:5432", "http://localhost:3000/v1", "http://localhost:3129"]) {
      for (const provider of ["ollama", "lmstudio", "custom"]) {
        expect(() => buildModel(row({ provider, baseUrl: url, endpointKind: "local" }), keyFn().getKey, { localServices: [new URL(url).host] }), `${provider} ${url}`).toThrow(/base URL/);
      }
    }
    for (const url of ["http://169.254.169.254/", "http://0.0.0.0:11434", "ftp://x.test", "http://u:p@x.test", "https://x.test/?k=1", "not a url"]) {
      expect(() => buildModel(row({ provider: "custom", baseUrl: url }), keyFn().getKey, { localServices: [] }), url).toThrow(/base URL/);
    }
  });

  it("a local provider or custom without a base URL is refused", () => {
    for (const provider of ["ollama", "lmstudio", "custom"]) expect(() => buildModel(row({ provider, baseUrl: null }), keyFn().getKey, { localServices: [] }), provider).toThrow(/base URL/);
  });

  it("a hosted provider never takes its address from the row (a key is not sent to a typed address)", () => {
    expect(() => buildModel(row({ provider: "openai", baseUrl: "https://evil.example.com/v1" }), keyFn().getKey, { localServices: [] })).toThrow(/own address/);
    expect(() => buildModel(row({ provider: "anthropic", baseUrl: "http://localhost:11434" }), keyFn().getKey, { localServices: [] })).toThrow(/own address/);
    expect(() => buildModel(row({ provider: "openai", baseUrl: PROVIDER_ENDPOINTS.openai.baseUrl }), keyFn().getKey, { localServices: [] })).not.toThrow();
  });

  it("an unknown provider is refused", () => {
    for (const provider of ["", "elevenlabs", "__proto__", "toString", "constructor"]) expect(() => buildModel(row({ provider }), keyFn().getKey, { localServices: [] }), provider).toThrow(/Unknown provider/);
  });

  it("the key is never sent through a redirect-capable path: requests are made with redirect manual", async () => {
    let redirect: RequestInit["redirect"];
    const fetch = (async (_u: unknown, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    await run(buildModel(row(), keyFn().getKey, { localServices: [], fetch }));
    expect(redirect).toBe("manual");
  });

  it("a header set by the SDK cannot hide a second key: exactly one authorization value", async () => {
    const o = recorder(body);
    await run(buildModel(row(), keyFn().getKey, { localServices: [], fetch: o.fetch }));
    expect(o.seen[0]!.headers.get("authorization")?.split(",")).toHaveLength(1);
  });
});
