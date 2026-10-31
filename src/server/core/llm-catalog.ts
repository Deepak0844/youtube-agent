import { z } from "zod";
import { ownServicePorts } from "@/server/core/local-services";
import { classifyAddress } from "@/server/core/net-policy";
import type { PriceCard } from "@/server/core/spend";

// Pure rules for the model catalog (Doc 08 section 3). Model ids are DATA: nothing here names a model.
// No IO: the SQL lives in src/server/db/llm-models.ts.

// Providers the catalog accepts (Doc 08 section 4). Most are one OpenAI-compatible adapter with a base URL.
export const PROVIDERS = [
  { id: "anthropic", label: "Anthropic", needsBaseUrl: false },
  { id: "openai", label: "OpenAI", needsBaseUrl: false },
  { id: "gemini", label: "Google Gemini", needsBaseUrl: false },
  { id: "deepseek", label: "DeepSeek", needsBaseUrl: false },
  { id: "openrouter", label: "OpenRouter", needsBaseUrl: false },
  { id: "groq", label: "Groq", needsBaseUrl: false },
  { id: "mistral", label: "Mistral", needsBaseUrl: false },
  { id: "xai", label: "xAI", needsBaseUrl: false },
  { id: "moonshot", label: "Moonshot / Kimi", needsBaseUrl: false },
  { id: "qwen", label: "Qwen (DashScope)", needsBaseUrl: false },
  { id: "together", label: "Together", needsBaseUrl: false },
  { id: "siliconflow", label: "SiliconFlow", needsBaseUrl: false },
  { id: "ollama", label: "Ollama", needsBaseUrl: true },
  { id: "lmstudio", label: "LM Studio", needsBaseUrl: true },
  { id: "custom", label: "Custom OpenAI-compatible", needsBaseUrl: true },
  // The owner's local Claude Code (`claude -p`, subscription login). Text stages only, no key, always free (ADR 0014).
  { id: "claude_code", label: "Claude Code (this machine, subscription, $0)", needsBaseUrl: false },
] as const;
export type ProviderId = (typeof PROVIDERS)[number]["id"];
const PROVIDER_IDS = PROVIDERS.map((p) => p.id) as [ProviderId, ...ProviderId[]];

// ---------- endpoint kind (derived, never typed) ----------

export type EndpointKind = "local" | "hosted";

function hostPort(raw: string, defaultScheme = "http"): { host: string; port: string } | undefined {
  try {
    const u = new URL(raw.includes("://") ? raw : `${defaultScheme}://${raw}`);
    return { host: u.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port: u.port };
  } catch {
    return undefined;
  }
}

const isIpLiteral = (h: string) => h.includes(":") || /^[0-9.]+$/.test(h);

/**
 * `local` only if the base URL is loopback, or a private/named host:port the owner put on the local-service allow-list.
 * `hosted` for everything else (and for no base URL: the provider's own endpoint). `invalid` for URLs that may never be
 * a model endpoint (bad scheme, credentials, query, metadata/link-local/unspecified addresses).
 * DNS names are NOT resolved here: a name that is not on the allow-list is hosted (fail closed, so never free).
 */
export function deriveEndpointKind(
  baseUrl: string | null,
  localServices: readonly string[],
  ownPorts?: ReadonlySet<number>,
): EndpointKind | "invalid" {
  if (baseUrl === null) return "hosted";
  // The app's own services (database, Redis, search, proxy, this app...) are never a model endpoint, whatever is listed.
  // If the own-service settings cannot be read nothing can be ruled out, so every URL is refused (fail closed).
  let own: ReadonlySet<number>;
  try {
    own = ownPorts ?? ownServicePorts();
  } catch {
    return "invalid";
  }
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return "invalid";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "invalid";
  if (u.username || u.password || u.search || u.hash || !u.hostname) return "invalid";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const onOwnPort = own.has(Number(port));
  const listed = localServices.some((e) => {
    const hp = hostPort(e);
    return hp !== undefined && hp.port !== "" && hp.host === host && hp.port === port;
  });
  if (!isIpLiteral(host)) {
    const loopbackName = host === "localhost" || host.endsWith(".localhost");
    if ((loopbackName || listed) && onOwnPort) return "invalid";
    return loopbackName || listed ? "local" : "hosted";
  }
  switch (classifyAddress(host)) {
    case "loopback":
      return onOwnPort ? "invalid" : "local";
    case "private":
    case "docker":
    case "cgnat":
      return onOwnPort ? "invalid" : listed ? "local" : "hosted";
    case "public":
      return "hosted";
    default:
      return "invalid";
  }
}

// ---------- model row, prices, capabilities ----------

const MAX_PRICE = 1_000_000_000_000; // $1M per million tokens: far above any real price, keeps sums in safe integers
const priceInt = z.number().int().min(0).max(MAX_PRICE);

export const priceBlockSchema = z.strictObject({
  inputPerMTokMicro: priceInt.min(1),
  outputPerMTokMicro: priceInt.min(1),
  cacheWritePerMTokMicro: priceInt.optional(),
  cacheReadPerMTokMicro: priceInt.optional(),
  reasoningPerMTokMicro: priceInt.optional(),
  perCallMicro: priceInt.optional(),
  perImageMicro: priceInt.optional(),
});
export type PriceBlock = z.infer<typeof priceBlockSchema>;

/** Stored prices are not trusted: anything that is not a valid block (zeros, strings, junk, unknown keys) is NO price. */
export function parseStoredPrices(raw: unknown): PriceBlock | null {
  if (raw === null || raw === undefined) return null;
  const r = priceBlockSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Thrown when a form field is longer than allowed. Never silently turned into an empty value. */
export class InputTooLongError extends Error {
  constructor() {
    super("A field is too long.");
    this.name = "InputTooLongError";
  }
}

/** Text of a form field: "" when absent; throws when over `max` characters or not text (a file). */
export function boundedText(v: FormDataEntryValue | null, max: number): string {
  if (v === null) return "";
  if (typeof v !== "string" || v.length > max) throw new InputTooLongError();
  return v;
}

export const capabilitiesSchema = z.strictObject({
  structuredOutput: z.boolean(),
  toolUse: z.boolean(),
  vision: z.boolean(),
  nativeWebSearch: z.boolean(),
  contextWindow: z.number().int().min(1).max(100_000_000),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type CapabilityFlag = Exclude<keyof Capabilities, "contextWindow">;

/**
 * The write contract of one catalog row. Rules (Doc 08 section 3, Doc 02 4.5):
 * - a paid model has a price block (positive input and output); a zero price is not a price;
 * - `isFree` only for a LOCAL endpoint, and then there are no prices;
 * - an enabled model is priced or free-local; an unpriced one can only be saved disabled;
 * - hosted endpoints use https. `endpointKind` is never accepted from the caller.
 */
export function modelInputSchema(localServices: readonly string[]) {
  return z
    .strictObject({
      provider: z.enum(PROVIDER_IDS),
      modelId: z.string().trim().min(1).max(200),
      label: z.string().trim().min(1).max(100),
      baseUrl: z.string().trim().max(300).nullable(),
      prices: priceBlockSchema.nullable(),
      isFree: z.boolean(),
      capabilities: capabilitiesSchema,
      enabled: z.boolean(),
    })
    .superRefine((m, ctx) => {
      const bad = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
      const needsUrl = PROVIDERS.find((p) => p.id === m.provider)?.needsBaseUrl ?? false;
      if (needsUrl && m.baseUrl === null) bad("baseUrl", "This provider needs a base URL.");
      if (m.provider === "claude_code") {
        // Runs on this machine through the owner's subscription: no address, no prices, always free.
        if (m.baseUrl !== null) bad("baseUrl", "Claude Code takes no base URL.");
        if (m.prices !== null || !m.isFree) bad("isFree", "Claude Code is free here (subscription, $0): tick free and leave prices empty.");
        // Tools are off in the adapter, so it may not claim them: tool stages (agent Draft, TSX, research, vision QA) never route to it.
        if (m.capabilities.toolUse || m.capabilities.vision || m.capabilities.nativeWebSearch) bad("capabilities", "Claude Code runs with tools off here: untick tool use, image input and web search.");
        return;
      }
      const kind = deriveEndpointKind(m.baseUrl, localServices);
      if (kind === "invalid") return bad("baseUrl", "That base URL cannot be used as a model endpoint.");
      if (kind === "hosted" && m.baseUrl !== null && new URL(m.baseUrl).protocol !== "https:") bad("baseUrl", "Hosted endpoints must use https.");
      if (m.isFree) {
        if (kind !== "local") bad("isFree", "Only a local endpoint (this machine, or an address on the local-service list) can be free.");
        if (m.prices !== null) bad("prices", "A free model has no prices.");
      } else if (m.prices === null && m.enabled) {
        bad("enabled", "A model without prices cannot be enabled.");
      }
    });
}
export type ModelInput = z.infer<ReturnType<typeof modelInputSchema>>;

export interface ModelRow {
  id: string;
  provider: string;
  modelId: string;
  label: string;
  baseUrl: string | null;
  prices: PriceBlock | null;
  isFree: boolean;
  capabilities: Capabilities;
  enabled: boolean;
  /** Stored at write time for display and as a DB check; every decision re-derives it from baseUrl. */
  endpointKind: EndpointKind;
}

/** The only bridge from a catalog row to the spend layer. No card means worstCaseMicroUsd throws UnpricedCallError. */
export function priceCardFor(model: Pick<ModelRow, "baseUrl" | "prices" | "isFree"> & { provider?: string }, localServices: readonly string[]): PriceCard | undefined {
  if (model.isFree) {
    const claudeCode = model.provider === "claude_code" && model.baseUrl === null; // subscription on this machine (ADR 0014)
    if (!claudeCode && deriveEndpointKind(model.baseUrl, localServices) !== "local") return undefined; // address left the allow-list: unpriced again
    return {
      inputPerMTokMicro: 0,
      outputPerMTokMicro: 0,
      cacheWritePerMTokMicro: 0,
      cacheReadPerMTokMicro: 0,
      reasoningPerMTokMicro: 0,
      perCallMicro: 0,
      perImageMicro: 0,
      perVideoSecondMicro: 0,
    };
  }
  const p = parseStoredPrices(model.prices);
  if (!p) return undefined;
  return {
    inputPerMTokMicro: p.inputPerMTokMicro,
    outputPerMTokMicro: p.outputPerMTokMicro,
    ...(p.cacheWritePerMTokMicro !== undefined && { cacheWritePerMTokMicro: p.cacheWritePerMTokMicro }),
    ...(p.cacheReadPerMTokMicro !== undefined && { cacheReadPerMTokMicro: p.cacheReadPerMTokMicro }),
    ...(p.reasoningPerMTokMicro !== undefined && { reasoningPerMTokMicro: p.reasoningPerMTokMicro }),
    ...(p.perCallMicro !== undefined && { perCallMicro: p.perCallMicro }),
    ...(p.perImageMicro !== undefined && { perImageMicro: p.perImageMicro }),
  };
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** May this model be used at all (enabled and priced, or free on a local endpoint)? */
export function checkModelUsable(model: ModelRow, localServices: readonly string[]): Verdict {
  if (!model.enabled) return { ok: false, reason: "The model is disabled." };
  if (!priceCardFor(model, localServices)) return { ok: false, reason: "The model has no price, so paid calls are refused." };
  return { ok: true };
}

// ---------- stages (Doc 08 section 3 table) ----------

export interface StageDef {
  id: string;
  label: string;
  hint: string;
  /** Every flag here is required. */
  requires: CapabilityFlag[];
  /** At least one of these is required (when non-empty). */
  requiresAny: CapabilityFlag[];
  /** Missing flags give a warning only. */
  prefers: { flag: CapabilityFlag; warning: string }[];
  /** Local models get this warning (soft). */
  localWarning?: string;
  optional?: boolean;
}

export const STAGES: readonly StageDef[] = [
  { id: "outline", label: "Outline", hint: "Structured output.", requires: ["structuredOutput"], requiresAny: [], prefers: [] },
  {
    id: "draft",
    label: "Draft",
    hint: "Script, beats and evidence proposal. Structured output; tool use for agent mode.",
    requires: ["structuredOutput"],
    requiresAny: [],
    prefers: [{ flag: "toolUse", warning: "No tool use: Draft runs in search-then-write mode, where the app does the searching." }],
  },
  // Sends no tools (tools: []), so a text-only model (local, Claude Code) can fill scene JSON.
  { id: "build_scene_kit", label: "Build, scene kit", hint: "Fills scene JSON. Built for cheap and local models.", requires: ["structuredOutput"], requiresAny: [], prefers: [] },
  {
    id: "build_tsx",
    label: "Build, Remotion TSX",
    hint: "Opt-in path. Needs tool use and strong coding.",
    requires: ["toolUse"],
    requiresAny: [],
    prefers: [],
    localWarning: "Small local models are not recommended for the TSX path.",
  },
  { id: "qa_vision", label: "QA, vision review", hint: "Optional review of frames. Leave unset to skip.", requires: ["vision"], requiresAny: [], prefers: [], optional: true },
  { id: "research", label: "Research and ideas", hint: "Native web search, or tool use with our own search tool.", requires: [], requiresAny: ["nativeWebSearch", "toolUse"], prefers: [] },
  { id: "titles", label: "Titles and insights", hint: "Structured output. Cheapest adequate model.", requires: ["structuredOutput"], requiresAny: [], prefers: [] },
  { id: "comment_replies", label: "Comment replies", hint: "Structured output. You approve before anything is sent.", requires: ["structuredOutput"], requiresAny: [], prefers: [] },
];

export const isStage = (id: string): boolean => STAGES.some((s) => s.id === id);

const FLAG_LABEL: Record<CapabilityFlag, string> = {
  structuredOutput: "structured output",
  toolUse: "tool use",
  vision: "image input",
  nativeWebSearch: "native web search",
};

export type Eligibility = { ok: true; warnings: string[] } | { ok: false; missing: string[] };

/** Capability check for one stage. The UI offers only `ok` models; there is no automatic fallback. */
export function eligibleForStage(stageId: string, model: Pick<ModelRow, "capabilities" | "endpointKind"> & { provider?: string }): Eligibility {
  const stage = STAGES.find((s) => s.id === stageId);
  if (!stage) return { ok: false, missing: ["unknown stage"] };
  // Claude Code runs with tools off (ADR 0014): judged tool-free whatever its row claims, so every caller (route writes,
  // the picker, the client, the AI source switch) refuses tool, image and web-search stages for it.
  const c = model.provider === "claude_code" ? { ...model.capabilities, toolUse: false, vision: false, nativeWebSearch: false } : model.capabilities;
  const missing = stage.requires.filter((f) => !c[f]).map((f) => FLAG_LABEL[f]);
  if (stage.requiresAny.length > 0 && !stage.requiresAny.some((f) => c[f])) missing.push(stage.requiresAny.map((f) => FLAG_LABEL[f]).join(" or "));
  if (missing.length > 0) return { ok: false, missing };
  const warnings = stage.prefers.filter((p) => !c[p.flag]).map((p) => p.warning);
  if (stage.localWarning && model.endpointKind === "local") warnings.push(stage.localWarning);
  return { ok: true, warnings };
}

// ---------- money text (integer micro-USD <-> dollars as typed) ----------

/** "3", "3.5", "0.075" (up to 6 decimals) -> integer micro-USD. Returns undefined for anything else (no float maths). */
export function usdToMicro(text: string): number | undefined {
  const m = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return undefined;
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
}

/** micro-USD -> "3.00" style text, at least 2 decimals, no trailing zeros beyond that. */
export function microToUsd(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const frac = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${frac}`;
}
