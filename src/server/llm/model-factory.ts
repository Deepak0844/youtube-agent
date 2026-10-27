import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { matchLocalService } from "@/server/core/local-services";
import { safeFetch } from "@/server/providers/net/safe-fetch";
import { PROVIDERS, deriveEndpointKind, type ModelRow, type ProviderId } from "@/server/core/llm-catalog";
import { PROVIDER_ENDPOINTS, keySlotFor } from "@/server/llm/provider-endpoints";

// Catalog row -> AI SDK language model. The key is never stored: it is fetched by `getKey` once per request, put on that one
// request, and dropped. Nothing here logs or returns it, and error messages never contain it.
//
// Address rules: a hosted provider always uses its fixed address (a row cannot redirect a key elsewhere). ollama, lmstudio and
// custom take the row's own base URL, which must pass deriveEndpointKind (never one of the app's own services, never metadata
// or link-local addresses) and be https unless it is local. Local addresses must be on the owner's local-service list (and
// local services are off in production until the own-service URLs are configured). Local addresses get no key.
// Traffic goes through safeFetch in typed mode: every address a name resolves to is checked (private/loopback only when listed,
// never an own-service port, never metadata) and the checked address is pinned for the connection (no DNS rebinding).
// Redirects are never followed.

export interface BuildOptions {
  /** The owner's local-service allow-list (setting `network.local_services`). */
  localServices: readonly string[];
  /** Tests only: replaces the transport. The default is the guarded safeFetch (typed mode, no redirects). */
  fetch?: typeof globalThis.fetch;
  /** Tests only: DNS answers for the guarded transport. */
  lookup?: (host: string) => Promise<string[]>;
  /** Tests only: environment for the production local-service rule. */
  env?: Record<string, string | undefined>;
  /** Tests only: override the app's own-service ports (as deriveEndpointKind). */
  ownPorts?: ReadonlySet<number>;
}

const MODEL_CALL_TIMEOUT_MS = 180_000;

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
    const url = new URL(row.baseUrl);
    if (local) {
      let listed = false;
      try {
        listed = matchLocalService(opts.localServices, url, opts.ownPorts, opts.env);
      } catch {
        // unreadable own-service settings: refuse
      }
      if (!listed) throw new Error("That local base URL is not on the local-service list, or local services are switched off until the server is configured.");
    } else if (url.protocol !== "https:") throw new Error("A base URL that is not on this machine must use https.");
    baseUrl = url.href;
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
    if (opts.fetch) return opts.fetch(input, { ...init, headers, redirect: "manual" });
    if (typeof input !== "string" && !(input instanceof URL)) throw new Error("Unsupported request.");
    return safeFetch(String(input), { ...init, headers }, { mode: "typed", localServices: opts.localServices, maxRedirects: 0, timeoutMs: MODEL_CALL_TIMEOUT_MS, lookup: opts.lookup });
  }) as typeof globalThis.fetch;

  if (native) return createAnthropic({ baseURL: baseUrl, apiKey: "set-per-request", fetch: keyed })(row.modelId);
  return createOpenAICompatible({ name: id, baseURL: baseUrl, fetch: keyed }).chatModel(row.modelId);
}
