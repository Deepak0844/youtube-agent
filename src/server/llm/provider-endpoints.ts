import { PROVIDERS, type ProviderId } from "@/server/core/llm-catalog";
import type { ProviderId as KeySlotId } from "@/server/core/provider-keys";

// Where each catalog provider is called. Pure data, no IO. Hosted providers have ONE fixed https address here and the
// model row can never override it (a key must not be sent to an address typed into a row). Only the providers that need
// a base URL (ollama, lmstudio, custom) take it from the row, and the factory checks it with deriveEndpointKind.
// Gemini and the others use their OpenAI-compatible route (Phase 2 overview); Gemini's built-in web search is not available there.

export interface ProviderEndpoint {
  adapter: "anthropic" | "openai-compatible" | "claude-code";
  baseUrl: string | null;
  sourceNote: string;
}

const CHECKED = "checked 2026-10-27: unauthenticated request to the address answers 401 (or 400 for Gemini chat), so host and path exist";

export const PROVIDER_ENDPOINTS: Record<ProviderId, ProviderEndpoint> = {
  anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com/v1", sourceNote: `https://docs.anthropic.com/en/api/getting-started, ${CHECKED}` },
  openai: { adapter: "openai-compatible", baseUrl: "https://api.openai.com/v1", sourceNote: `https://platform.openai.com/docs/api-reference, ${CHECKED}` },
  gemini: {
    adapter: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    sourceNote: `https://ai.google.dev/gemini-api/docs/openai, ${CHECKED}`,
  },
  deepseek: { adapter: "openai-compatible", baseUrl: "https://api.deepseek.com", sourceNote: `https://api-docs.deepseek.com, ${CHECKED}` },
  openrouter: { adapter: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", sourceNote: `https://openrouter.ai/docs/api-reference/overview, ${CHECKED}` },
  groq: { adapter: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", sourceNote: `https://console.groq.com/docs/openai, ${CHECKED}` },
  mistral: { adapter: "openai-compatible", baseUrl: "https://api.mistral.ai/v1", sourceNote: `https://docs.mistral.ai/api, ${CHECKED}` },
  xai: { adapter: "openai-compatible", baseUrl: "https://api.x.ai/v1", sourceNote: `https://docs.x.ai/docs/api-reference, ${CHECKED}` },
  moonshot: { adapter: "openai-compatible", baseUrl: "https://api.moonshot.ai/v1", sourceNote: `https://platform.moonshot.ai/docs, ${CHECKED}` },
  qwen: {
    adapter: "openai-compatible",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    sourceNote: `NOTE: current docs use workspace-scoped URLs; this host answers 401 but the /models path used by the key test is unverified. https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope (international region), ${CHECKED}`,
  },
  together: { adapter: "openai-compatible", baseUrl: "https://api.together.ai/v1", sourceNote: `https://docs.together.ai/docs/openai-api-compatibility, ${CHECKED}` },
  siliconflow: { adapter: "openai-compatible", baseUrl: "https://api.siliconflow.com/v1", sourceNote: `https://docs.siliconflow.com/en/api-reference, ${CHECKED}` },
  ollama: { adapter: "openai-compatible", baseUrl: null, sourceNote: `https://github.com/ollama/ollama/blob/main/docs/openai.md, base URL comes from the model row (OpenAI route at /v1); 2026-10-27, address not probed` },
  lmstudio: { adapter: "openai-compatible", baseUrl: null, sourceNote: `https://lmstudio.ai/docs/app/api/endpoints/openai, base URL comes from the model row; 2026-10-27, address not probed` },
  claude_code: { adapter: "claude-code", baseUrl: null, sourceNote: `https://docs.anthropic.com/en/docs/claude-code/cli-reference, local \`claude -p\` process, no address; flags checked against \`claude --help\` 2.1.207 on 2026-10-31 (ADR 0014)` },
  custom: { adapter: "openai-compatible", baseUrl: null, sourceNote: `https://platform.openai.com/docs/api-reference/chat, any OpenAI-compatible server; base URL comes from the model row; 2026-10-27, not probed` },
};

/** Providers that run on the owner's machine: no key slot, no key is ever read or sent. */
export const LOCAL_PROVIDERS = ["ollama", "lmstudio", "claude_code"] as const;

const CATALOG_IDS: ReadonlySet<string> = new Set(PROVIDERS.map((p) => p.id));

/** The vault key slot of a catalog provider (same id), or null for a local provider. Throws for a name outside the catalog. */
export function keySlotFor(provider: ProviderId): KeySlotId | null {
  if (!CATALOG_IDS.has(provider)) throw new Error("Unknown provider.");
  return (LOCAL_PROVIDERS as readonly string[]).includes(provider) ? null : (provider as KeySlotId);
}
