import type { AgentTool } from "@/server/core/agent-loop";
import { searxSearch, type SearxResult } from "@/server/llm/searxng-client";
import { safeFetch } from "@/server/providers/net/safe-fetch";

// Read-only web tools for the Draft agent (Doc 8 §2). Output is untrusted data: it is returned as plain text with
// a size cap and nothing in it is ever executed. Every URL a tool returns is recorded in `seen`, so a caller can
// check that cited sources are real (the model cannot invent a source the tools never returned).

const MAX_TEXT = 8_000;

export function createWebTools(opts: { searxUrl: string; fetchImpl?: typeof safeFetch; searchImpl?: (query: string) => Promise<SearxResult[]> }) {
  const seen = new Set<string>();
  const fetcher = opts.fetchImpl ?? safeFetch;
  const searx = new URL(opts.searxUrl);
  const search = opts.searchImpl ?? ((q: string) => searxSearch(opts.searxUrl, q));
  const own = [{ host: searx.hostname, port: Number(searx.port || (searx.protocol === "https:" ? 443 : 80)) }];

  const tools: AgentTool[] = [
    {
      name: "webSearch",
      async run(args) {
        const q = (args as { query?: unknown } | null)?.query;
        if (typeof q !== "string" || q.trim() === "" || q.length > 300) throw new Error("query must be a short string");
        const rows = (await search(q)).slice(0, 8);
        for (const r of rows) seen.add(r.url);
        return rows.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.content}`).join("\n\n") || "no results";
      },
    },
    {
      name: "fetchPage",
      async run(args) {
        const url = (args as { url?: unknown } | null)?.url;
        if (typeof url !== "string" || !seen.has(url)) throw new Error("fetchPage only accepts a URL returned by webSearch");
        const res = await fetcher(url, undefined, { mode: "indirect", ownServices: own, timeoutMs: 15_000 });
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const html = (await res.text()).slice(0, 400_000);
        const text = html
          .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return text.slice(0, MAX_TEXT);
      },
    },
  ];
  return { tools, seen };
}
