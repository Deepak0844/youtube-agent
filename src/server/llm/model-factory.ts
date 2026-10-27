import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { PROVIDERS, deriveEndpointKind, type ModelRow, type ProviderId } from "@/server/core/llm-catalog";
import { PROVIDER_ENDPOINTS, keySlotFor } from "@/server/llm/provider-endpoints";

// Catalog row -> AI SDK language model. The key is never stored: it is fetched by `getKey` once per request, put on that one
// request, and dropped. Nothing here logs or returns it, and error messages never contain it.
//
// Address rules: a hosted provider always uses its fixed address (a row cannot redirect a key elsewhere). ollama, lmstudio and
// custom take the row's own base URL, which must pass deriveEndpointKind (never one of the app's own services, never metadata
// or link-local addresses) and be https unless it is local. Local addresses get no key. Requests never follow redirects.

export interface BuildOptions {
  /** The owner's local-service allow-list (setting `network.local_services`). */
  localServices: readonly string[];
  /** Tests only: the transport. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Tests only: override the app's own-service ports (as deriveEndpointKind). */
  ownPorts?: ReadonlySet<number>;
}

const BY_ID = new Map<string, { id: ProviderId; label: string }>(PROVIDERS.map((p) => [p.id, { id: p.id, label: p.label }]));

export function buildModel(row: ModelRow, getKey: () => Promise<string | null>, opts: BuildOptions): LanguageModel {
  const known = BY_ID.get(row.provider);
  if (!known) throw new Error("Unknown provider.");
  const { id, label } = known;
  const endpoint = PROVIDER_ENDPOINTS[id];

  let baseUrl: string;
  let local = false;
  if (endpoint.baseUrl !== null) {
    if (row.baseUrl !== null && row.baseUrl !== endpoint.baseUrl) throw new Error(`${label} is called at its own address; remove the base URL from the model.`);
    baseUrl = endpoint.baseUrl;
  } else {
    if (row.baseUrl === null) throw new Error(`${label} needs a base URL.`);
    const kind = deriveEndpointKind(row.baseUrl, opts.localServices, opts.ownPorts);
    if (kind === "invalid") throw new Error("That base URL cannot be used as a model endpoint.");
    local = kind === "local";
    if (!local && new URL(row.baseUrl).protocol !== "https:") throw new Error("A base URL that is not on this machine must use https.");
    baseUrl = row.baseUrl;
  }

  const needsKey = keySlotFor(id) !== null && !(id === "custom" && local);
  const native = endpoint.adapter === "anthropic";

  const keyed = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("x-api-key");
    if (needsKey) {
      let key: string | null;
      try {
        key = await getKey();
      } catch {
        throw new Error(`Could not read the key for ${label}.`); // the cause is dropped: it could carry request context
      }
      if (!key) throw new Error(`No key saved for ${label}`);
      if (native) headers.set("x-api-key", key);
      else headers.set("authorization", `Bearer ${key}`);
    }
    return (opts.fetch ?? globalThis.fetch)(input, { ...init, headers, redirect: "manual" });
  }) as typeof globalThis.fetch;

  if (native) return createAnthropic({ baseURL: baseUrl, apiKey: "set-per-request", fetch: keyed })(row.modelId);
  return createOpenAICompatible({ name: id, baseURL: baseUrl, fetch: keyed }).chatModel(row.modelId);
}
