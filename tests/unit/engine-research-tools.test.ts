import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebTools } from "@/server/llm/web-tools";
import { researchTools } from "@/server/engine/mcp/research-tools";
import type { McpTool } from "@/server/engine/mcp/protocol";

// The tools of a research run (script writing): the app's own web tools, so safeFetch rules and "only URLs the search
// returned" stay in force, plus check_script, which judges draft/script.json against the pages really fetched.

let work: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "res-work-"));
  await mkdir(path.join(work, "draft"));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const PAGE = "<html><script>x()</script><body>Docker packs an app with everything it needs.</body></html>";
function setup(over: { judge?: (raw: unknown, fetched: ReadonlyMap<string, string>) => { ok: true } | { ok: false; problems: string[] }; page?: string } = {}) {
  const fetchedUrls: string[] = [];
  const web = createWebTools({
    searxUrl: "http://127.0.0.1:8080",
    searchImpl: async () => [{ title: "Docker", url: "https://example.com/docker", content: "about docker" }],
    fetchImpl: (async (url: string) => {
      fetchedUrls.push(url);
      return new Response(over.page ?? PAGE, { status: 200 });
    }) as never,
  });
  const fetched = new Map<string, string>();
  const tools = researchTools({ workDir: work, web, fetched, judge: over.judge ?? (() => ({ ok: true })) });
  const by = (n: string): McpTool => tools.find((t) => t.name === n)!;
  return { tools, by, fetched, fetchedUrls };
}
const text = (r: { type: string; text?: string }[]) => r.map((c) => c.text ?? "").join("\n");

describe("researchTools", () => {
  it("offers_exactly_search_fetch_and_check", () => {
    expect(setup().tools.map((t) => t.name).sort()).toEqual(["check_script", "web_fetch", "web_search"]);
  });

  it("web_fetch_refuses_urls_search_never_returned", async () => {
    const s = setup();
    await s.by("web_search").run({ query: "docker" });
    for (const url of ["http://169.254.169.254/latest", "file:///etc/passwd", "http://localhost:3000/", "https://example.com/other"]) {
      await expect(s.by("web_fetch").run({ url })).rejects.toThrow(/returned by/);
    }
    expect(s.fetchedUrls).toEqual([]);
  });

  it("web_fetch_records_the_cleaned_page", async () => {
    const s = setup();
    await s.by("web_search").run({ query: "docker" });
    const out = text(await s.by("web_fetch").run({ url: "https://example.com/docker" }) as never);
    expect(out).toContain("Docker packs an app");
    expect(out).not.toContain("x()");
    expect(s.fetched.get("https://example.com/docker")).toContain("Docker packs an app");
  });

  it("web_search_and_fetch_output_is_capped", async () => {
    const s = setup({ page: `<body>${"word ".repeat(5000)}</body>` });
    await s.by("web_search").run({ query: "docker" });
    const out = text(await s.by("web_fetch").run({ url: "https://example.com/docker" }) as never);
    expect(out.length).toBeLessThanOrEqual(4600);
    expect(s.fetched.get("https://example.com/docker")!.length).toBeLessThanOrEqual(4600);
  });

  it("at_most_six_distinct_pages_are_fetched", async () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://example.com/p${i}`);
    const web = createWebTools({
      searxUrl: "http://127.0.0.1:8080",
      searchImpl: async () => urls.map((url) => ({ title: "t", url, content: "c" })),
      fetchImpl: (async () => new Response("<body>text</body>", { status: 200 })) as never,
    });
    const tools = researchTools({ workDir: work, web, fetched: new Map(), judge: () => ({ ok: true }) });
    const get = (n: string) => tools.find((t) => t.name === n)!;
    await get("web_search").run({ query: "x" });
    for (const u of urls.slice(0, 6)) await get("web_fetch").run({ url: u });
    await expect(get("web_fetch").run({ url: urls[6] })).rejects.toThrow(/at most 6/);
  });

  it("check_script_judges_the_file_against_fetched_pages", async () => {
    let seen: ReadonlyMap<string, string> | null = null;
    const s = setup({ judge: (raw, f) => { seen = f; return (raw as { ok?: boolean }).ok ? { ok: true } : { ok: false, problems: ["claim 1: the quote does not appear on that page"] }; } });
    await s.by("web_search").run({ query: "docker" });
    await s.by("web_fetch").run({ url: "https://example.com/docker" });
    await writeFile(path.join(work, "draft", "script.json"), JSON.stringify({ ok: false }));
    expect(text(await s.by("check_script").run({}) as never)).toContain("quote does not appear");
    expect([...seen!.keys()]).toEqual(["https://example.com/docker"]);
    await writeFile(path.join(work, "draft", "script.json"), JSON.stringify({ ok: true }));
    expect(text(await s.by("check_script").run({}) as never)).toMatch(/passes/i);
  });

  it("check_script_refuses_bad_paths_links_big_and_non_json", async () => {
    const s = setup();
    await expect(s.by("check_script").run({ file: "../x.json" })).rejects.toThrow(/inside the work folder/);
    await expect(s.by("check_script").run({ file: "draft/none.json" })).rejects.toThrow(/no file/);
    await writeFile(path.join(work, "real.json"), "{}");
    await symlink(path.join(work, "real.json"), path.join(work, "draft", "link.json"));
    await expect(s.by("check_script").run({ file: "draft/link.json" })).rejects.toThrow(/Links/);
    await writeFile(path.join(work, "draft", "big.json"), "x".repeat(70 * 1024));
    await expect(s.by("check_script").run({ file: "draft/big.json" })).rejects.toThrow(/64 KB/);
    await writeFile(path.join(work, "draft", "bad.json"), "{nope");
    await expect(s.by("check_script").run({ file: "draft/bad.json" })).rejects.toThrow(/not valid JSON/);
  });
});
