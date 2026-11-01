import { describe, expect, it, vi } from "vitest";
import { createWebTools } from "@/server/llm/web-tools";

describe("web tools", () => {
  it("search_records_urls_and_fetch_only_accepts_them", async () => {
    const f = vi.fn(async () => new Response("<p>Hello <script>x()</script>world</p>"));
    const searchImpl = async () => [{ title: "T", url: "https://a.test/x", content: "c" }];
    const { tools, seen } = createWebTools({ searxUrl: "http://127.0.0.1:8888", fetchImpl: f as never, searchImpl });
    const [search, page] = tools as [(typeof tools)[number], (typeof tools)[number]];
    expect(await search.run({ query: "q" })).toContain("https://a.test/x");
    expect(seen.has("https://a.test/x")).toBe(true);
    expect(await page.run({ url: "https://a.test/x" })).toBe("Hello world");
    await expect(page.run({ url: "https://evil.test/" })).rejects.toThrow(/returned by webSearch/);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("search_uses_searchImpl_and_fetchPage_stays_indirect_with_own_services", async () => {
    const f = vi.fn(async () => new Response("<p>Hi</p>"));
    const searchImpl = vi.fn(async () => [{ title: "T", url: "https://a.test/x", content: "c" }]);
    const { tools } = createWebTools({ searxUrl: "http://127.0.0.1:8888", fetchImpl: f as never, searchImpl });
    expect(await tools[0]!.run({ query: "q" })).toContain("https://a.test/x");
    expect(searchImpl).toHaveBeenCalledWith("q");
    expect(f).not.toHaveBeenCalled();
    await tools[1]!.run({ url: "https://a.test/x" });
    const opts = (f.mock.calls[0] as unknown as [string, unknown, Record<string, unknown>])[2];
    expect(opts.mode).toBe("indirect");
    expect(opts.ownServices).toEqual([{ host: "127.0.0.1", port: 8888 }]);
  });
  it("rejects_bad_query", async () => {
    const { tools } = createWebTools({ searxUrl: "http://127.0.0.1:8888", fetchImpl: vi.fn() as never });
    await expect(tools[0]!.run({ query: "" })).rejects.toThrow();
  });
});
