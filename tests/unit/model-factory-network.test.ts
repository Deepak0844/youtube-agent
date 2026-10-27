import { createServer as netServer, type Server as NetServer } from "node:net";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ModelRow } from "@/server/core/llm-catalog";
import { createAiSdkStep } from "@/server/llm/ai-sdk-step";
import { buildModel } from "@/server/llm/model-factory";

const KEY = "sk-SECRET-KEY-VALUE-0123456789abcdef";
const row = (o: Partial<ModelRow> = {}): ModelRow => ({
  id: "00000000-0000-4000-8000-000000000003",
  provider: "custom",
  modelId: "m-1",
  label: "M",
  baseUrl: null,
  prices: { inputPerMTokMicro: 1, outputPerMTokMicro: 1 },
  isFree: false,
  capabilities: { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 1000 },
  enabled: true,
  endpointKind: "hosted",
  ...o,
});
const body = {
  id: "c1", object: "chat.completion", created: 1, model: "m-1",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};
const run = (m: ReturnType<typeof buildModel>) => createAiSdkStep(m, [], 50)([{ role: "user", content: "go" }], "k");
const getKey = async () => KEY;
// The SDK wraps transport errors ("Cannot connect to API"), so look for the guard's own error in the cause chain.
async function refusedByGuard(p: Promise<unknown>, label = ""): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, `${label}: should reject`).toBeDefined();
  const names: string[] = [];
  for (let e: unknown = err; e && names.length < 8; e = (e as { cause?: unknown }).cause) names.push((e as Error).name);
  expect(names, label).toContain("BlockedAddressError");
}
const never = () => {
  throw new Error("must not be built");
};

// A TCP listener that only counts connections: a refused request must never even connect.
let tcp: NetServer;
let tcpPort: number;
let connections = 0;
beforeAll(async () => {
  tcp = netServer((s) => {
    connections++;
    s.destroy();
  });
  await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
  tcpPort = (tcp.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => tcp.close(() => r())));
afterEach(() => {
  connections = 0;
});

describe("factory traffic goes through the guarded fetcher (no key to internal addresses)", () => {
  it("a hosted-looking name that resolves to loopback is refused and nothing connects", async () => {
    const m = buildModel(row({ baseUrl: `https://llm.example.com:${tcpPort}/v1` }), getKey, { localServices: [], lookup: async () => ["127.0.0.1"] });
    await refusedByGuard(run(m));
    expect(connections).toBe(0);
  });
  it("same for a private address, link-local metadata, and a mixed answer where one address is internal", async () => {
    for (const answer of [["10.0.0.5"], ["169.254.169.254"], ["8.8.8.8", "127.0.0.1"], ["::1"], ["::ffff:127.0.0.1"]]) {
      const m = buildModel(row({ baseUrl: `https://llm.example.com:${tcpPort}/v1` }), getKey, { localServices: [], lookup: async () => answer });
      await refusedByGuard(run(m), answer.join());
    }
    expect(connections).toBe(0);
  });
  it("a hosted-looking name on an own-service port that resolves to loopback is refused as an own service", async () => {
    for (const port of [5432, 6379, 3000]) {
      const m = buildModel(row({ baseUrl: `https://llm.example.com:${port}/v1` }), getKey, { localServices: [`127.0.0.1:${port}`], lookup: async () => ["127.0.0.1"] });
      await refusedByGuard(run(m), String(port));
    }
  });
  it("trailing-dot localhost on an own port is refused (resolves to loopback)", async () => {
    const m = buildModel(row({ baseUrl: "https://localhost.:3000/v1" }), getKey, { localServices: [], lookup: async () => ["127.0.0.1"] });
    await refusedByGuard(run(m));
  });
  it("a trailing-dot name never counts as a local service, even if someone wrote it in the list by hand", () => {
    expect(() => buildModel(row({ provider: "ollama", baseUrl: "http://localhost.:11434/v1" }), never, { localServices: ["localhost.:11434"] })).toThrow();
  });
  it("a DNS-name allow-list entry makes that exact name:port local (no key, no https needed)", () => {
    expect(() => buildModel(row({ provider: "custom", baseUrl: "http://host.docker.internal:11434/v1" }), never, { localServices: ["host.docker.internal:11434"] })).not.toThrow();
    expect(() => buildModel(row({ provider: "custom", baseUrl: "http://host.docker.internal:11434/v1" }), never, { localServices: [] })).toThrow(/https/);
    expect(() => buildModel(row({ provider: "custom", baseUrl: "http://host.docker.internal:9999/v1" }), never, { localServices: ["host.docker.internal:11434"] })).toThrow(/https/);
  });
});

describe("fail closed on server settings", () => {
  const set = (k: string, v: string | undefined) => {
    const old = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    return () => (old === undefined ? delete process.env[k] : (process.env[k] = old));
  };
  it("ownServicePorts throwing makes every row-address provider refuse to build", () => {
    const undo = set("SEARXNG_URL", "not a url");
    try {
      for (const provider of ["ollama", "lmstudio", "custom"]) {
        expect(() => buildModel(row({ provider, baseUrl: "http://localhost:11434/v1" }), never, { localServices: [] }), provider).toThrow(/base URL/);
        expect(() => buildModel(row({ provider, baseUrl: "https://llm.example.com/v1" }), never, { localServices: [] }), provider).toThrow(/base URL/);
      }
    } finally {
      undo();
    }
  });
  it("in production with the own-service URLs unset, local addresses are refused (hosted https custom still builds)", () => {
    const env = { NODE_ENV: "production" } as Record<string, string | undefined>;
    expect(() => buildModel(row({ provider: "ollama", baseUrl: "http://localhost:11434/v1" }), never, { localServices: ["localhost:11434"] })).not.toThrow(); // same list, not production
    for (const provider of ["ollama", "lmstudio", "custom"]) {
      expect(() => buildModel(row({ provider, baseUrl: "http://localhost:11434/v1" }), never, { localServices: ["localhost:11434"], env }), provider).toThrow(/switched off|configured/);
    }
    expect(() => buildModel(row({ provider: "custom", baseUrl: "https://llm.example.com/v1" }), never, { localServices: [], env })).not.toThrow();
    const ready = { NODE_ENV: "production", RENDER_RUNNER_URL: "http://127.0.0.1:4100", FETCHER_URL: "http://127.0.0.1:4200", SEARXNG_URL: "http://127.0.0.1:8888", EGRESS_PROXY_URL: "http://127.0.0.1:3128" };
    expect(() => buildModel(row({ provider: "ollama", baseUrl: "http://localhost:11434/v1" }), never, { localServices: ["localhost:11434"], env: ready })).not.toThrow();
  });
});

describe("header hygiene and redirects on the real transport", () => {
  let srv: Server;
  let port: number;
  const hits: Array<{ url: string; auth?: string; xkey?: string }> = [];
  let mode: "ok" | "redirect" = "ok";
  beforeAll(async () => {
    srv = createServer((req, res) => {
      hits.push({ url: req.url ?? "", auth: req.headers.authorization, xkey: req.headers["x-api-key"] as string | undefined });
      if (mode === "redirect" && req.url?.endsWith("/chat/completions")) {
        res.writeHead(302, { location: `/elsewhere` });
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));
  afterEach(() => {
    hits.length = 0;
    mode = "ok";
  });
  const local = () => buildModel(row({ provider: "ollama", baseUrl: `http://127.0.0.1:${port}/v1`, endpointKind: "local" }), getKey, { localServices: [`127.0.0.1:${port}`] });

  it("works end to end against a local server through the guarded fetcher, with no key sent", async () => {
    const r = await run(local());
    expect(r.text).toBe("hi");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.auth).toBeUndefined();
  });
  it("a stale authorization or x-api-key handed in by the caller is stripped on the keyless local path", async () => {
    const m = local() as unknown as { doGenerate(o: unknown): Promise<unknown> };
    await m.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }], headers: { authorization: "Bearer STALE", "x-api-key": "STALE" } });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.auth).toBeUndefined();
    expect(hits[0]!.xkey).toBeUndefined();
  });
  it("a real 302 is not followed: one request, the redirect target is never requested", async () => {
    mode = "redirect";
    await expect(run(local())).rejects.toThrow();
    expect(hits.map((h) => h.url)).toEqual(["/v1/chat/completions"]);
  });
});
