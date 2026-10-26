import { describe, expect, it, vi } from "vitest";
import { createWebTools } from "@/server/llm/web-tools";

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });

describe("web tools", () => {
  it("search_records_urls_and_fetch_only_accepts_them", async () => {
    const f = vi.fn(async (url: string) =>
      url.includes("/search") ? json({ results: [{ title: "T", url: "https://a.test/x", content: "c" }] }) : new Response("<p>Hello <script>x()</script>world</p>"),
    );
    const { tools, seen } = createWebTools({ searxUrl: "http://127.0.0.1:8888", fetchImpl: f as never });
    const [search, page] = tools as [(typeof tools)[number], (typeof tools)[number]];
    expect(await search.run({ query: "q" })).toContain("https://a.test/x");
    expect(seen.has("https://a.test/x")).toBe(true);
    expect(await page.run({ url: "https://a.test/x" })).toBe("Hello world");
    await expect(page.run({ url: "https://evil.test/" })).rejects.toThrow(/returned by webSearch/);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("rejects_bad_query", async () => {
    const { tools } = createWebTools({ searxUrl: "http://127.0.0.1:8888", fetchImpl: vi.fn() as never });
    await expect(tools[0]!.run({ query: "" })).rejects.toThrow();
  });
});
