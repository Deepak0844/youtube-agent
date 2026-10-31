import { describe, expect, it } from "vitest";
import {
  STAGES,
  PROVIDERS,
  deriveEndpointKind,
  modelInputSchema,
  eligibleForStage,
  checkModelUsable,
  priceCardFor,
  usdToMicro,
  microToUsd,
  parseStoredPrices,
  boundedText,
  InputTooLongError,
  type ModelRow,
} from "@/server/core/llm-catalog";
import { UnpricedCallError, worstCaseMicroUsd } from "@/server/core/spend";

const caps = { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 };
const prices = { inputPerMTokMicro: 3_000_000, outputPerMTokMicro: 15_000_000 };
const hosted = { provider: "anthropic", modelId: "m-1", label: "M", baseUrl: null, prices, isFree: false, capabilities: caps, enabled: true };
const parse = (o: object, local: string[] = []) => modelInputSchema(local).safeParse({ ...hosted, ...o });

describe("endpoint kind (derived, never typed)", () => {
  it.each([
    ["http://localhost:11434/v1", [], "local"],
    ["http://127.0.0.1:1234", [], "local"],
    ["http://[::1]:11434", [], "local"],
    ["http://2130706433:11434", [], "local"],
    ["http://192.168.1.20:11434", [], "hosted"],
    ["http://192.168.1.20:11434", ["192.168.1.20:11434"], "local"],
    ["http://192.168.1.20:11434", ["192.168.1.20:9999"], "hosted"],
    ["http://host.docker.internal:11434", [], "hosted"],
    ["http://host.docker.internal:11434", ["host.docker.internal:11434"], "local"],
    ["https://api.openai.com/v1", [], "hosted"],
    ["https://localhost.evil.com", [], "hosted"],
    [null, [], "hosted"],
  ] as const)("%s with %j is %s", (url, list, kind) => {
    expect(deriveEndpointKind(url, [...list])).toBe(kind);
  });
  it("refuses addresses that can never be a model endpoint", () => {
    for (const u of ["http://169.254.169.254/", "http://0.0.0.0:11434", "http://[::]:1", "ftp://x.test", "http://u:p@x.test", "https://x.test/?k=1", "not a url"]) {
      expect(deriveEndpointKind(u, []), u).toBe("invalid");
    }
  });
});

describe("a model base URL never points at one of the app's own services", () => {
  const OWN = new Set([5432, 6379, 8888, 3128, 3000]);
  it.each([
    "http://localhost:5432/v1",
    "http://127.0.0.1:6379",
    "http://[::1]:8888/v1",
    "http://127.0.0.2:3128",
    "http://2130706433:5432",
    "http://foo.localhost:3000",
    "http://localhost:3000/v1",
    "http://192.168.1.20:5432/v1",
    "http://10.0.0.5:6379",
    "http://172.17.0.2:8888",
    "http://100.64.0.9:3128",
  ])("%s is invalid, even if it is on the allow-list", (url) => {
    const host = new URL(url).host.replace(/^\[(.*)\]/, "[$1]");
    expect(deriveEndpointKind(url, [], OWN), url).toBe("invalid");
    expect(deriveEndpointKind(url, [host], OWN), `${url} listed`).toBe("invalid");
  });
  it("other ports on the same hosts are unchanged", () => {
    expect(deriveEndpointKind("http://localhost:11434", [], OWN)).toBe("local");
    expect(deriveEndpointKind("http://192.168.1.20:11434", ["192.168.1.20:11434"], OWN)).toBe("local");
    expect(deriveEndpointKind("http://192.168.1.20:11434", [], OWN)).toBe("hosted");
  });
  it("a public host on an own port is not this app's service", () => {
    expect(deriveEndpointKind("https://api.example.com:6379/v1", [], OWN)).toBe("hosted");
  });
  it("uses the real own-service ports by default (including PORT and deployment URLs)", () => {
    expect(deriveEndpointKind("http://localhost:5432", [])).toBe("invalid");
  });
  it("fails closed when an own-service setting cannot be read", () => {
    const old = process.env.SEARXNG_URL;
    process.env.SEARXNG_URL = "not a url";
    try {
      expect(deriveEndpointKind("http://localhost:11434", [])).toBe("invalid");
      expect(deriveEndpointKind("https://api.openai.com/v1", [])).toBe("invalid");
      expect(deriveEndpointKind(null, [])).toBe("hosted"); // no URL: the provider's own endpoint, nothing local to check
    } finally {
      if (old === undefined) delete process.env.SEARXNG_URL;
      else process.env.SEARXNG_URL = old;
    }
  });
});

describe("price and free rules", () => {
  it("a priced hosted model is accepted", () => expect(parse({}).success).toBe(true));
  it("a hosted model cannot be free", () => {
    expect(parse({ isFree: true, prices: null }).success).toBe(false);
    expect(parse({ isFree: true, prices: null, baseUrl: "https://api.x.test/v1" }).success).toBe(false);
  });
  it("a local model may be free, with no prices", () => {
    expect(parse({ provider: "ollama", baseUrl: "http://localhost:11434/v1", isFree: true, prices: null }).success).toBe(true);
  });
  it("free local with prices is refused (one source of truth)", () => {
    expect(parse({ provider: "ollama", baseUrl: "http://localhost:11434/v1", isFree: true }).success).toBe(false);
  });
  it("enabling an unpriced model is refused; saving it disabled is fine", () => {
    expect(parse({ prices: null }).success).toBe(false);
    expect(parse({ prices: null, enabled: false }).success).toBe(true);
  });
  it("hosted input/output must be positive integers; optional ones non-negative integers", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
      expect(parse({ prices: { ...prices, inputPerMTokMicro: bad } }).success, `in ${bad}`).toBe(false);
      expect(parse({ prices: { ...prices, outputPerMTokMicro: bad } }).success, `out ${bad}`).toBe(false);
    }
    expect(parse({ prices: { ...prices, cacheWritePerMTokMicro: 0, cacheReadPerMTokMicro: 5, perCallMicro: 10_000 } }).success).toBe(true);
    expect(parse({ prices: { ...prices, cacheReadPerMTokMicro: -1 } }).success).toBe(false);
    expect(parse({ prices: { ...prices, perCallMicro: 0.5 } }).success).toBe(false);
    expect(parse({ prices: { inputPerMTokMicro: 1 } }).success).toBe(false);
  });
  it("unknown fields are refused (no smuggled endpointKind)", () => {
    expect(parse({ endpointKind: "local" }).success).toBe(false);
  });
  it("http is only for local endpoints", () => {
    expect(parse({ baseUrl: "http://api.x.test/v1" }).success).toBe(false);
    expect(parse({ baseUrl: "https://api.x.test/v1" }).success).toBe(true);
  });
  it("ollama, lmstudio and custom need a base URL", () => {
    for (const provider of ["ollama", "lmstudio", "custom"]) expect(parse({ provider, baseUrl: null }).success, provider).toBe(false);
  });
  it("unknown provider, empty model id and bad capabilities are refused", () => {
    expect(parse({ provider: "nope" }).success).toBe(false);
    expect(parse({ modelId: "  " }).success).toBe(false);
    expect(parse({ capabilities: { ...caps, contextWindow: 0 } }).success).toBe(false);
    expect(parse({ capabilities: { ...caps, toolUse: "yes" } }).success).toBe(false);
  });
  it("lists the documented providers", () => {
    for (const p of ["anthropic", "openai", "gemini", "deepseek", "openrouter", "groq", "mistral", "xai", "moonshot", "qwen", "together", "siliconflow", "ollama", "lmstudio", "custom"]) {
      expect(PROVIDERS.map((x) => x.id)).toContain(p);
    }
  });
});

describe("price card adapter (no unpriced paid calls)", () => {
  const row = (o: Partial<ModelRow> = {}): ModelRow => ({ id: "00000000-0000-4000-8000-000000000001", ...hosted, endpointKind: "hosted", ...o });
  const usage = { inputTokens: 1000, maxOutputTokens: 1000 };
  it("a priced model gets a card that reserves money", () => {
    expect(worstCaseMicroUsd(priceCardFor(row(), []), usage)).toBeGreaterThan(0);
  });
  it("an unpriced paid model has no card, so the spend layer refuses it", () => {
    expect(priceCardFor(row({ prices: null }), [])).toBeUndefined();
    expect(() => worstCaseMicroUsd(priceCardFor(row({ prices: null }), []), usage)).toThrow(UnpricedCallError);
  });
  it("free local model costs zero", () => {
    const m = row({ provider: "ollama", baseUrl: "http://localhost:11434/v1", prices: null, isFree: true, endpointKind: "local" });
    expect(worstCaseMicroUsd(priceCardFor(m, []), usage)).toBe(0);
  });
  it("free model whose private address left the allow-list becomes unpriced", () => {
    const m = row({ provider: "ollama", baseUrl: "http://192.168.1.20:11434", prices: null, isFree: true, endpointKind: "local" });
    expect(priceCardFor(m, ["192.168.1.20:11434"])).toBeDefined();
    expect(() => worstCaseMicroUsd(priceCardFor(m, []), usage)).toThrow(UnpricedCallError);
  });
});

describe("money text", () => {
  it("parses dollars without floats and rejects junk", () => {
    expect(usdToMicro("3")).toBe(3_000_000);
    expect(usdToMicro("0.075")).toBe(75_000);
    expect(usdToMicro("15.00")).toBe(15_000_000);
    for (const bad of ["", "-1", "1e3", "1.1234567", "abc", "1,5", "$3"]) expect(usdToMicro(bad), bad).toBeUndefined();
    expect(microToUsd(3_000_000)).toBe("3.00");
    expect(microToUsd(75_000)).toBe("0.075");
  });
});

describe("stored prices are not trusted on read", () => {
  const bad: [string, unknown][] = [
    ["zero input and output", { inputPerMTokMicro: 0, outputPerMTokMicro: 0 }],
    ["string prices", { inputPerMTokMicro: "3000000", outputPerMTokMicro: "15000000" }],
    ["empty object", {}],
    ["unknown key", { ...prices, freeLunch: 1 }],
    ["negative optional", { ...prices, cacheReadPerMTokMicro: -5 }],
    ["fractional", { inputPerMTokMicro: 1.5, outputPerMTokMicro: 2 }],
    ["array", [1, 2]],
    ["scalar", 7],
  ];
  it.each(bad)("%s gives no price", (_n, p) => {
    expect(parseStoredPrices(p)).toBeNull();
    const card = priceCardFor({ baseUrl: null, prices: p as never, isFree: false }, []);
    expect(card).toBeUndefined();
    expect(() => worstCaseMicroUsd(card, { inputTokens: 1, maxOutputTokens: 1 })).toThrow(UnpricedCallError);
  });
  it("a good block survives and null stays null", () => {
    expect(parseStoredPrices(prices)).toEqual(prices);
    expect(parseStoredPrices(null)).toBeNull();
  });
});

describe("form text is bounded, never silently emptied", () => {
  it("returns the text, empty for a missing field, and throws when too long or not text", () => {
    expect(boundedText("abc", 5)).toBe("abc");
    expect(boundedText(null, 5)).toBe("");
    expect(() => boundedText("x".repeat(6), 5)).toThrow(InputTooLongError);
    expect(() => boundedText(new File([], "a"), 5)).toThrow(InputTooLongError);
  });
});

describe("stage routing and capabilities", () => {
  const m = (c: Partial<typeof caps>, o: Partial<ModelRow> = {}): ModelRow => ({ id: "00000000-0000-4000-8000-000000000002", ...hosted, endpointKind: "hosted", ...o, capabilities: { ...caps, ...c } });
  it("stages follow Doc 8 section 3 and are unique", () => {
    expect(STAGES.map((s) => s.id)).toEqual(["outline", "draft", "build_scene_kit", "build_tsx", "qa_vision", "research", "titles", "comment_replies"]);
  });
  it("structured-output stages exclude models without it", () => {
    for (const id of ["outline", "titles", "comment_replies"]) expect(eligibleForStage(id, m({ structuredOutput: false })).ok, id).toBe(false);
    expect(eligibleForStage("outline", m({})).ok).toBe(true);
  });
  it("tool use is soft for draft (search-then-write mode), not needed for the scene kit (no tools), hard for TSX", () => {
    const noTools = m({ toolUse: false });
    const d = eligibleForStage("draft", noTools);
    expect(d.ok).toBe(true);
    expect(d.ok && d.warnings.join(" ")).toMatch(/tool/i);
    expect(eligibleForStage("build_scene_kit", noTools).ok).toBe(true); // build sends no tools (tools: [])
    expect(eligibleForStage("build_tsx", noTools).ok).toBe(false);
  });
  it("qa_vision needs vision; research needs web search or tools", () => {
    expect(eligibleForStage("qa_vision", m({})).ok).toBe(false);
    expect(eligibleForStage("qa_vision", m({ vision: true })).ok).toBe(true);
    expect(eligibleForStage("research", m({ toolUse: false, nativeWebSearch: false })).ok).toBe(false);
    expect(eligibleForStage("research", m({ toolUse: false, nativeWebSearch: true })).ok).toBe(true);
  });
  it("a claude_code row counts as tool-free whatever it claims (tools are off in the adapter)", () => {
    const cc = { ...m({ toolUse: true, vision: true, nativeWebSearch: true }), provider: "claude_code" };
    for (const id of ["build_tsx", "qa_vision", "research"]) expect(eligibleForStage(id, cc).ok, id).toBe(false);
    for (const id of ["outline", "draft", "build_scene_kit", "titles", "comment_replies"]) expect(eligibleForStage(id, cc).ok, id).toBe(true);
  });
  it("unknown stage is refused", () => expect(eligibleForStage("nope", m({})).ok).toBe(false));
  it("a route target must be enabled and priced (or free local)", () => {
    expect(checkModelUsable(m({}), []).ok).toBe(true);
    expect(checkModelUsable(m({}, { enabled: false }), []).ok).toBe(false);
    expect(checkModelUsable(m({}, { prices: null }), []).ok).toBe(false);
    expect(checkModelUsable(m({}, { prices: null, isFree: true, endpointKind: "hosted" }), []).ok).toBe(false);
  });
});
