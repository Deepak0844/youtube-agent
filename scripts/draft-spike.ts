// Manual check (not CI): runs the real Draft (runDraft) against your local Ollama / LM Studio (or Anthropic) and SearXNG.
// Output goes to the terminal only; nothing is written to the database and nothing is checkpointed.
//
//   DRAFT_PROVIDER=openai-compatible DRAFT_BASE_URL=http://127.0.0.1:11434/v1 DRAFT_MODEL=qwen2.5:7b \
//   SEARXNG_URL=http://127.0.0.1:8888 npx tsx scripts/draft-spike.ts "Why do octopuses have three hearts?"
//
// DRAFT_PROVIDER: "openai-compatible" (free local model, price 0) or "anthropic" (needs ANTHROPIC_API_KEY and
// DRAFT_IN_PER_M_USD / DRAFT_OUT_PER_M_USD: no price = refused). DRAFT_MODE: "search_then_write" (default) or "agent".
// DRAFT_LANG (default en), DRAFT_CAP_USD (default 0.5; spend is tracked in memory only).
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { runDraft } from "@/server/authoring/draft";
import { buildEngineConfig } from "@/server/core/engine-config";
import { isLang } from "@/server/core/lang";
import type { ModelRow } from "@/server/core/llm-catalog";
import type { PaidCallPorts } from "@/server/core/paid-call";
import { createStageContext } from "@/server/core/stage-handler";
import { createLlmClient } from "@/server/llm/client";
import { createWebTools } from "@/server/llm/web-tools";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};
const usdMicro = (k: string): number => Math.round(Number(need(k)) * 1_000_000);

async function main() {
  const topic = process.argv[2] ?? "Why do octopuses have three hearts?";
  const lang = process.env.DRAFT_LANG ?? "en";
  if (!isLang(lang)) throw new Error("DRAFT_LANG must be one of en hi ta te ml kn");
  const mode = process.env.DRAFT_MODE === "agent" ? "agent" : "search_then_write";
  const anthropic = (process.env.DRAFT_PROVIDER ?? "openai-compatible") === "anthropic";
  const baseUrl = anthropic ? null : need("DRAFT_BASE_URL");
  const localHost = baseUrl ? new URL(baseUrl) : null;

  const caps = { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 };
  const row: ModelRow = {
    id: "00000000-0000-4000-8000-000000000000",
    provider: anthropic ? "anthropic" : "ollama",
    modelId: need("DRAFT_MODEL"),
    label: need("DRAFT_MODEL"),
    baseUrl,
    prices: anthropic ? { inputPerMTokMicro: usdMicro("DRAFT_IN_PER_M_USD"), outputPerMTokMicro: usdMicro("DRAFT_OUT_PER_M_USD") } : null,
    isFree: !anthropic,
    capabilities: caps,
    enabled: true,
    endpointKind: anthropic ? "hosted" : "local",
  };
  const llm = createLlmClient({
    db: undefined as never,
    catalog: { route: async () => row, localServices: async () => (localHost ? [`${localHost.hostname}:${localHost.port || "80"}`] : []) },
    getKey: async () => process.env.ANTHROPIC_API_KEY ?? null,
    buildModel: () =>
      anthropic
        ? createAnthropic({ apiKey: need("ANTHROPIC_API_KEY") })(row.modelId)
        : createOpenAICompatible({ name: "local", baseURL: baseUrl!, apiKey: process.env.DRAFT_API_KEY })(row.modelId),
    budgetScopes: () => ["spike"],
  });

  const capMicro = Number(process.env.DRAFT_CAP_USD ?? "0.5") * 1e6;
  let spentMicro = 0;
  let n = 0;
  const ports: PaidCallPorts = {
    reserve: async (_c, a) => (spentMicro + a.reserveMicroUsd > capMicro ? { kind: "refused", reason: "cap" } : { kind: "new", intentId: String(++n) }),
    settle: async (_id, a) => void (spentMicro += a.actualMicroUsd),
    failKnown: async () => {},
    markUnknown: async () => {},
    markStageNeedsDecision: async () => {},
    warn: (e, d) => console.warn(e, d),
  };
  const ctx = createStageContext({
    stage: { id: "draft-spike", name: "draft", inputHash: "spike" },
    claim: { stageRunId: "draft-spike", fence: 1, workerId: "spike", leaseUntil: new Date(Date.now() + 3_600_000), jobId: "spike" },
    config: buildEngineConfig(new Map()),
    signal: new AbortController().signal,
    paid: ports,
  }).ctx;
  const web = createWebTools({ searxUrl: process.env.SEARXNG_URL ?? "http://127.0.0.1:8888" });

  const out = await runDraft(ctx, { llm, web, db: undefined as never, mode, store: null }, { topic, lang, kind: "scene_kit" });
  console.log(JSON.stringify(out.script, null, 2));
  console.log({ topic, mode, spentUsd: spentMicro / 1e6, evidenceClaims: out.script.evidence.length });
}
main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
