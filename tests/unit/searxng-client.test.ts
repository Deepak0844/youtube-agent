import { describe, expect, it, vi } from "vitest";
import { searxSearch } from "@/server/llm/searxng-client";

const jsonRes = (o: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => new Response(JSON.stringify(o), { status: 200, headers });
const ok = () => vi.fn(async () => jsonRes({ results: [{ title: "T", url: "https://a.test/x", content: "c" }] }));

describe("searxSearch", () => {
  it("builds_fixed_url_and_parses", async () => {
    const f = ok();
    const r = await searxSearch("http://127.0.0.1:8080/ignored?x=1", "hello world", { fetchImpl: f });
    expect(r).toEqual([{ title: "T", url: "https://a.test/x", content: "c" }]);
    const [url, init, pinned] = f.mock.calls[0] as unknown as [string, { method: string; redirect: string }, string[]];
    expect(url).toBe("http://127.0.0.1:8080/search?q=hello+world&format=json");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(pinned).toEqual(["127.0.0.1"]);
  });
  it("accepts_private_and_docker_hostnames", async () => {
    for (const ip of ["192.168.1.5", "10.0.0.2"]) {
      await expect(searxSearch("http://searxng:8080", "q", { fetchImpl: ok(), lookup: async () => [ip] })).resolves.toHaveLength(1);
    }
  });
  it.each([
    ["public ip", "http://8.8.8.8:8080", undefined],
    ["public via dns", "http://searx.example.com", async () => ["93.184.216.34"]],
    ["one bad of many", "http://searx.example.com", async () => ["127.0.0.1", "8.8.8.8"]],
    ["metadata", "http://169.254.169.254", undefined],
    ["link-local", "http://169.254.1.1", undefined],
    ["userinfo", "http://user:pw@127.0.0.1:8080", undefined],
    ["scheme", "ftp://127.0.0.1", undefined],
    ["garbage", "not a url", undefined],
  ])("refuses_%s", async (_n, url, lookup) => {
    const f = ok();
    await expect(searxSearch(url, "q", { fetchImpl: f, lookup })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
  it("error_never_leaks_userinfo", async () => {
    await expect(searxSearch("http://user:secret@127.0.0.1", "q", { fetchImpl: ok() })).rejects.not.toThrow(/secret/);
  });
  it("rejects_long_or_empty_query", async () => {
    await expect(searxSearch("http://127.0.0.1", "x".repeat(301), { fetchImpl: ok() })).rejects.toThrow(/query/);
    await expect(searxSearch("http://127.0.0.1", " ", { fetchImpl: ok() })).rejects.toThrow(/query/);
  });
  it("redirect_error_propagates", async () => {
    const f = vi.fn(async () => { throw new TypeError("redirect mode is set to error"); });
    await expect(searxSearch("http://127.0.0.1", "q", { fetchImpl: f })).rejects.toThrow();
  });
  it("refuses_non_ok_without_body", async () => {
    const f = vi.fn(async () => new Response("SECRET-BODY", { status: 302 }));
    await expect(searxSearch("http://127.0.0.1", "q", { fetchImpl: f })).rejects.toThrow(/^search failed: 302$/);
  });
  it("refuses_non_json_content_type", async () => {
    const f = vi.fn(async () => jsonRes({ results: [] }, { "content-type": "text/html" }));
    await expect(searxSearch("http://127.0.0.1", "q", { fetchImpl: f })).rejects.toThrow(/not JSON/);
  });
  it("aborts_oversize_body", async () => {
    const f = vi.fn(async () => jsonRes({ results: [{ url: "https://a.test", content: "x".repeat(5000) }] }));
    await expect(searxSearch("http://127.0.0.1", "q", { fetchImpl: f, maxBytes: 1000 })).rejects.toThrow(/too large/);
  });
  it("invalid_json_does_not_echo_body", async () => {
    const f = vi.fn(async () => new Response("SECRET{", { headers: { "content-type": "application/json" } }));
    await expect(searxSearch("http://127.0.0.1", "q", { fetchImpl: f })).rejects.toThrow(/^search response was not valid JSON$/);
  });
  it("caps_results_and_strings", async () => {
    const results = Array.from({ length: 30 }, (_, i) => ({ title: "t".repeat(999), url: `https://a.test/${i}`, content: "c".repeat(9999) }));
    results.splice(1, 0, { title: "no url" } as never, { url: 5 } as never);
    const f = vi.fn(async () => jsonRes({ results }));
    const r = await searxSearch("http://127.0.0.1", "q", { fetchImpl: f });
    expect(r).toHaveLength(10);
    expect(r[0]!.title).toHaveLength(200);
    expect(r[0]!.content).toHaveLength(500);
    expect(r.every((x) => x.url.startsWith("https://a.test/"))).toBe(true);
  });
  it("missing_results_is_empty", async () => {
    const f = vi.fn(async () => jsonRes({}));
    expect(await searxSearch("http://127.0.0.1", "q", { fetchImpl: f })).toEqual([]);
  });
});
