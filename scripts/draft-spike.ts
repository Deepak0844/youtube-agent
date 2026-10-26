// Spike A live check: can a model produce valid, really-sourced evidence with webSearch/fetchPage?
// Needs ANTHROPIC_API_KEY, DRAFT_MODEL, DRAFT_IN_PER_M_USD, DRAFT_OUT_PER_M_USD (prices are yours; no price = refused)
// and SearXNG at SEARXNG_URL (default http://127.0.0.1:8888). Spend is tracked in memory only.
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { runAgent } from "@/server/core/agent-loop";
import type { PaidCallPorts } from "@/server/core/paid-call";
import { createAiSdkStep } from "@/server/llm/ai-sdk-step";
import { createWebTools } from "@/server/llm/web-tools";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};
const usd = (k: string): number => Math.round(Number(need(k)) * 1_000_000);

const Evidence = z.object({
  claims: z.array(z.object({ claim: z.string().min(10), sourceUrl: z.url(), quote: z.string().min(10) })).min(3),
});

async function main() {
  const topic = process.argv[2] ?? "Why do octopuses have three hearts?";
  const { tools, seen } = createWebTools({ searxUrl: process.env.SEARXNG_URL ?? "http://127.0.0.1:8888" });
  const capUsd = Number(process.env.DRAFT_CAP_USD ?? "0.5");
  let spentMicro = 0;
  let n = 0;
  const ports: PaidCallPorts = {
    reserve: async (_c, a) => (spentMicro + a.reserveMicroUsd > capUsd * 1e6 ? { kind: "refused", reason: "cap" } : { kind: "new", intentId: String(++n) }),
    settle: async (_id, a) => void (spentMicro += a.actualMicroUsd),
    failKnown: async () => {},
    markUnknown: async () => {},
    markStageNeedsDecision: async () => {},
    warn: (e, d) => console.warn(e, d),
  };
  const anthropic = createAnthropic({ apiKey: need("ANTHROPIC_API_KEY") });
  const decls = [
    { name: "webSearch", description: "Search the web. Returns titles, URLs, snippets.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "fetchPage", description: "Fetch text of a URL previously returned by webSearch.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  ];
  const out = await runAgent({
    claim: { stageRunId: "spike-a" } as never,
    ports,
    price: { inputPerMTokMicro: usd("DRAFT_IN_PER_M_USD"), outputPerMTokMicro: usd("DRAFT_OUT_PER_M_USD") },
    budgetScopes: ["spike"],
    maxOutputTokens: 2000,
    maxSteps: 10,
    step: createAiSdkStep(anthropic(need("DRAFT_MODEL")), decls, 2000),
    tools,
    messages: [
      { role: "system", content: 'You research facts for a short video. Use webSearch (and fetchPage) to find real sources. Finish with ONLY JSON: {"claims":[{"claim":"...","sourceUrl":"<url returned by webSearch>","quote":"<exact words from the source>"}]} with at least 3 claims.' },
      { role: "user", content: `Topic: ${topic}` },
    ],
  });
  const json = out.text.match(/\{[\s\S]*\}/)?.[0] ?? "";
  const parsed = Evidence.safeParse(JSON.parse(json || "null"));
  const fake = parsed.success ? parsed.data.claims.filter((c) => !seen.has(c.sourceUrl)) : [];
  console.log({ steps: out.steps, spentUsd: spentMicro / 1e6, contractOk: parsed.success, invented: fake.length });
  process.exitCode = parsed.success && fake.length === 0 ? 0 : 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
