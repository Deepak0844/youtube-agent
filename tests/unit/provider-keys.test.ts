import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAuditEvent, redactDetail } from "@/server/core/audit-events";
import { PROVIDERS, checkKeyShape, isProviderId, keyTestRequest, secretName, statusToResult, vaultNotice } from "@/server/core/provider-keys";
import { runKeyTest } from "@/server/providers/key-test";
import { safeFetch } from "@/server/providers/net/safe-fetch";

const SAMPLES: Record<string, string> = {
  anthropic: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
  openai: "sk-proj-abcdefghijklmnopqrstuvwxyz0123_-",
  gemini: "AIzaSyA-abcdefghijklmnopqrstuvwxyz01234",
  deepseek: "sk-abcdefghijklmnopqrstuvwxyz012345",
  openrouter: "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123",
  elevenlabs: "sk_abcdefghijklmnopqrstuvwxyz0123456789",
  pexels: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP",
  pixabay: "12345678-abcdef0123456789abcdef012",
};

describe("provider list", () => {
  it("is exactly the eight owner-approved providers, in order", () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(["anthropic", "openai", "gemini", "deepseek", "openrouter", "elevenlabs", "pexels", "pixabay"]);
  });
  it("secret names are provider.<id>.api_key and match the vault name rule", () => {
    for (const p of PROVIDERS) {
      expect(secretName(p.id)).toBe(`provider.${p.id}.api_key`);
      expect(secretName(p.id)).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/);
    }
  });
  it("isProviderId rejects anything else, including prototype names", () => {
    expect(isProviderId("openai")).toBe(true);
    for (const bad of ["", "OpenAI", "toString", "__proto__", "constructor", "../x", 5, null, undefined]) expect(isProviderId(bad)).toBe(false);
  });
  it("audit catalogue already has the three key events", () => {
    for (const e of ["key.set", "key.removed", "key.tested"]) expect(isAuditEvent(e)).toBe(true);
  });
});

describe("shape check", () => {
  it.each(Object.entries(SAMPLES))("%s: accepts a plausible key and trims surrounding whitespace", (id, key) => {
    expect(checkKeyShape(id, key)).toEqual({ ok: true, value: key });
    expect(checkKeyShape(id, `  ${key}\n`)).toEqual({ ok: true, value: key });
  });
  it.each(Object.keys(SAMPLES))("%s: rejects garbage without echoing it", (id) => {
    for (const bad of ["", "   ", "hello", "short", "sk-ant", "a b c d e f g h i j k l m n o p q r s t", "\u0000".repeat(30), "x".repeat(5000), "sk-ant-api03-abc def-ghijklmnopqrstuvwxyz"]) {
      const r = checkKeyShape(id, bad);
      expect(r.ok, `${id}: ${JSON.stringify(bad).slice(0, 30)}`).toBe(false);
      if (!r.ok && bad.trim().length > 12) expect(r.message).not.toContain(bad.trim());
    }
  });
  it("a key for one provider is refused by a provider with a distinct prefix", () => {
    expect(checkKeyShape("anthropic", SAMPLES.openai!).ok).toBe(false);
    expect(checkKeyShape("openrouter", SAMPLES.deepseek!).ok).toBe(false);
  });
  it("non-string input is refused", () => {
    for (const bad of [null, undefined, 5, {}, ["x"]]) expect(checkKeyShape("openai", bad).ok).toBe(false);
    expect(checkKeyShape("nope", SAMPLES.openai).ok).toBe(false);
  });
});

describe("test requests are fixed, free and key-bearing only for the provider", () => {
  const FIXED: Record<string, string> = {
    anthropic: "https://api.anthropic.com/v1/models",
    openai: "https://api.openai.com/v1/models",
    gemini: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    deepseek: "https://api.deepseek.com/models",
    openrouter: "https://openrouter.ai/api/v1/key",
    elevenlabs: "https://api.elevenlabs.io/v1/models",
    pexels: "https://api.pexels.com/v1/curated?per_page=1",
  };
  it.each(Object.entries(FIXED))("%s uses a fixed GET url", (id, url) => {
    const r = keyTestRequest(id as never, SAMPLES[id]!);
    expect(r.url).toBe(url);
    expect(r.method).toBe("GET");
    expect(JSON.stringify([...Object.entries(r.headers)])).toContain(SAMPLES[id]!);
    expect(r.url).not.toContain(SAMPLES[id]!);
  });
  it("pixabay can only carry its key in the query string, on its own host", () => {
    const r = keyTestRequest("pixabay", SAMPLES.pixabay!);
    const u = new URL(r.url);
    expect(u.origin).toBe("https://pixabay.com");
    expect(u.pathname).toBe("/api/");
    expect(u.searchParams.get("key")).toBe(SAMPLES.pixabay);
  });
  it("only https hosts, no body, never a paid verb", () => {
    for (const p of PROVIDERS) {
      const r = keyTestRequest(p.id, SAMPLES[p.id]!);
      expect(r.url.startsWith("https://")).toBe(true);
      expect(r.method).toBe("GET");
      expect(new URL(r.url).pathname).not.toMatch(/messages|completions|generate|speech|text-to|embeddings|images/);
    }
  });
});

describe("status mapping", () => {
  it("2xx works, 401/403 rejected, anything else is a failure to reach a verdict", () => {
    expect(statusToResult(200)).toBe("ok");
    expect(statusToResult(204)).toBe("ok");
    expect(statusToResult(401)).toBe("rejected");
    expect(statusToResult(403)).toBe("rejected");
    for (const s of [301, 400, 404, 429, 500, 503]) expect(statusToResult(s)).toBe("unreachable");
  });
});

describe("vault notice (fail closed)", () => {
  it("ok has no banner and allows saving", () => expect(vaultNotice("ok")).toEqual({ canSave: true, message: null }));
  it("every other state blocks saving with a clear owner-facing message", () => {
    for (const s of ["missing_key", "wrong_key", "unreadable"] as const) {
      const n = vaultNotice(s);
      expect(n.canSave).toBe(false);
      expect(n.message).toMatch(/VAULT_MASTER_KEY|vault/i);
    }
    expect(vaultNotice("missing_key").message).toMatch(/vault:init/);
    expect(vaultNotice("wrong_key").message).toMatch(/does not match/i);
  });
});

describe("audit detail shape survives redaction", () => {
  it("provider, tail and outcome pass through unredacted", () => {
    const { safe, redacted } = redactDetail({ provider: "openai", tail: "abcd", replaced: true, result: "ok" });
    expect(redacted).toEqual([]);
    expect(safe).toEqual({ provider: "openai", tail: "abcd", replaced: true, result: "ok" });
  });
});

describe("runKeyTest against a fake provider", () => {
  let srv: Server;
  let port: number;
  const seen: Array<{ url: string; xkey?: string; method?: string }> = [];
  let mode: "ok" | "401" | "500" | "redirect" | "hang" = "ok";
  const KEY = "sk-ant-api03-FAKE-TEST-KEY-ZZZZZZZZZZZZZZZZ";
  beforeAll(async () => {
    srv = createServer((req: IncomingMessage, res) => {
      seen.push({ url: req.url ?? "", xkey: req.headers["x-api-key"] as string | undefined, method: req.method });
      if (mode === "hang") return;
      if (mode === "redirect") {
        res.writeHead(302, { location: "http://127.0.0.1:1/steal" });
        return res.end();
      }
      res.writeHead(mode === "ok" ? 200 : Number(mode), { "content-type": "application/json" });
      res.end(JSON.stringify({ echo: KEY, data: [] })); // a hostile body: it must never come back
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));

  // Re-points the fixed https url at the local fake and allows loopback; everything else is the real safeFetch.
  const fetcher = (url: string, init: RequestInit, o: { timeoutMs: number; maxRedirects: number }) => {
    const u = new URL(url);
    seen.length = 0;
    return safeFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init, { mode: "typed", ...o });
  };

  it("ok: sends the key to the provider once and returns only a verdict", async () => {
    mode = "ok";
    const r = await runKeyTest("anthropic", KEY, { fetcher });
    expect(r).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "/v1/models", xkey: KEY, method: "GET" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
  it("401 is rejected; 500 is unreachable", async () => {
    mode = "401";
    expect(await runKeyTest("anthropic", KEY, { fetcher })).toBe("rejected");
    mode = "500";
    expect(await runKeyTest("anthropic", KEY, { fetcher })).toBe("unreachable");
  });
  it("a redirect is never followed (the key cannot be forwarded)", async () => {
    mode = "redirect";
    expect(await runKeyTest("openai", KEY, { fetcher })).toBe("unreachable");
    expect(seen).toHaveLength(1);
  });
  it("a hanging provider times out to unreachable", async () => {
    mode = "hang";
    const t0 = Date.now();
    expect(await runKeyTest("openai", KEY, { fetcher, timeoutMs: 300 })).toBe("unreachable");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it("a network failure is unreachable and the thrown error text never leaks", async () => {
    const boom = async () => {
      throw new Error(`connect failed with ${KEY}`);
    };
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      expect(await runKeyTest("openai", KEY, { fetcher: boom })).toBe("unreachable");
    } finally {
      console.error = orig;
    }
    expect(logs.join("\n")).not.toContain(KEY);
  });
  it("the default path fails closed when the fixed host resolves to a loopback address", async () => {
    const blocked = (url: string, init: RequestInit, o: { timeoutMs: number; maxRedirects: number }) =>
      safeFetch(url, init, { mode: "indirect", lookup: async () => ["127.0.0.1"], ...o });
    expect(await runKeyTest("openai", KEY, { fetcher: blocked })).toBe("unreachable");
  });
});
