// Provider API keys: the fixed provider list, key-shape sanity checks, the fixed free "test" request per provider and the
// vault notice. Pure: no IO. The DB side is src/server/db/provider-keys.ts, the network side src/server/providers/key-test.ts.
// Rule: a test is ONE read-only GET to a hard-coded https host (list models / key info). Nothing here can build a paid call.

export const PROVIDER_IDS = ["anthropic", "openai", "gemini", "deepseek", "openrouter", "groq", "mistral", "xai", "moonshot", "qwen", "together", "siliconflow", "custom", "elevenlabs", "pexels", "pixabay", "google_tts", "azure_speech", "coverr", "fal", "voicestudio", "local_voice"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type KeyTestResult = "ok" | "rejected" | "unreachable";

interface ProviderDef {
  id: ProviderId;
  label: string;
  role: "Language model" | "Voice" | "Image" | "Stock media";
  note: string;
  shape: RegExp;
  shapeHint: string;
}

const printable = "[\\x21-\\x7e]"; // no spaces, controls or non-ASCII

export const PROVIDERS: readonly ProviderDef[] = [
  { id: "anthropic", label: "Anthropic", role: "Language model", note: "Claude models", shape: new RegExp(`^sk-ant-${printable}{16,300}$`), shapeHint: "starts with sk-ant-" },
  { id: "openai", label: "OpenAI", role: "Language model", note: "GPT models", shape: new RegExp(`^sk-${printable}{16,300}$`), shapeHint: "starts with sk-" },
  { id: "gemini", label: "Gemini", role: "Language model", note: "Google AI Studio key", shape: /^(AIza[\w-]{30,60}|AQ\.[\w.-]{20,300})$/, shapeHint: "starts with AIza or AQ." },
  { id: "deepseek", label: "DeepSeek", role: "Language model", note: "DeepSeek API", shape: new RegExp(`^sk-${printable}{16,300}$`), shapeHint: "starts with sk-" },
  { id: "openrouter", label: "OpenRouter", role: "Language model", note: "One key, many models", shape: new RegExp(`^sk-or-${printable}{16,300}$`), shapeHint: "starts with sk-or-" },
  { id: "groq", label: "Groq", role: "Language model", note: "Groq API", shape: new RegExp(`^gsk_${printable}{16,300}$`), shapeHint: "starts with gsk_" },
  { id: "mistral", label: "Mistral", role: "Language model", note: "Mistral API", shape: /^[A-Za-z0-9]{24,100}$/, shapeHint: "letters and digits only" },
  { id: "xai", label: "xAI", role: "Language model", note: "Grok models", shape: new RegExp(`^xai-${printable}{16,300}$`), shapeHint: "starts with xai-" },
  { id: "moonshot", label: "Moonshot / Kimi", role: "Language model", note: "Kimi models", shape: new RegExp(`^sk-${printable}{16,300}$`), shapeHint: "starts with sk-" },
  { id: "qwen", label: "Qwen (DashScope)", role: "Language model", note: "Alibaba Cloud Model Studio, international", shape: new RegExp(`^sk-${printable}{16,300}$`), shapeHint: "starts with sk-" },
  { id: "together", label: "Together", role: "Language model", note: "Together AI", shape: /^[A-Za-z0-9_-]{32,200}$/, shapeHint: "letters, digits, _ and - only" },
  { id: "siliconflow", label: "SiliconFlow", role: "Language model", note: "SiliconFlow international", shape: new RegExp(`^sk-${printable}{16,300}$`), shapeHint: "starts with sk-" },
  { id: "custom", label: "Custom endpoint", role: "Language model", note: "Key for your own OpenAI-compatible address. Checked by the model Test button, not here.", shape: new RegExp(`^${printable}{8,300}$`), shapeHint: "8 or more visible characters" },
  { id: "elevenlabs", label: "ElevenLabs", role: "Voice", note: "Used from Phase 3", shape: /^(sk_[A-Za-z0-9]{20,200}|[a-f0-9]{32})$/, shapeHint: "starts with sk_ (or 32 hex characters)" },
  { id: "pexels", label: "Pexels", role: "Stock media", note: "Free stock photos and video, used from Phase 3", shape: /^[A-Za-z0-9]{20,100}$/, shapeHint: "letters and digits only" },
  { id: "pixabay", label: "Pixabay", role: "Stock media", note: "Free stock images, used from Phase 3", shape: /^[0-9]{4,}-[A-Za-z0-9]{16,64}$/, shapeHint: "looks like 12345678-abcdef..." },
  { id: "google_tts", label: "Google text to speech", role: "Voice", note: "Cloud Text-to-Speech API key", shape: /^AIza[\w-]{30,60}$/, shapeHint: "starts with AIza" },
  { id: "azure_speech", label: "Azure speech", role: "Voice", note: "Speech resource key", shape: /^[A-Za-z0-9]{32,100}$/, shapeHint: "letters and digits only, 32 or more" },
  { id: "coverr", label: "Coverr", role: "Stock media", note: "Stock video", shape: /^[A-Za-z0-9_-]{16,100}$/, shapeHint: "letters, digits, _ and - only" },
  { id: "fal", label: "fal", role: "Image", note: "Image generation", shape: /^[\w-]{8,100}:[\w-]{8,200}$/, shapeHint: "two parts joined by a colon" },
  { id: "voicestudio", label: "VoiceStudio", role: "Voice", note: "Optional. Needed only when the server is not on this machine.", shape: new RegExp(`^${printable}{8,300}$`), shapeHint: "8 or more visible characters" },
  { id: "local_voice", label: "Local voice server", role: "Voice", note: "Optional. Needed only when the server is not on this machine.", shape: new RegExp(`^${printable}{8,300}$`), shapeHint: "8 or more visible characters" },
];

const BY_ID = new Map<string, ProviderDef>(PROVIDERS.map((p) => [p.id, p]));

export const isProviderId = (v: unknown): v is ProviderId => typeof v === "string" && BY_ID.has(v);
export const providerDef = (id: ProviderId): ProviderDef => BY_ID.get(id)!;
export const secretName = (id: ProviderId): string => `provider.${id}.api_key`;

export type ShapeResult = { ok: true; value: string } | { ok: false; message: string };

/** Trims surrounding whitespace (pasted newlines) and checks the shape. The message never contains the input. */
export function checkKeyShape(id: string, raw: unknown): ShapeResult {
  const p = BY_ID.get(id);
  if (!p) return { ok: false, message: "Unknown provider." };
  if (typeof raw !== "string") return { ok: false, message: "Paste the key into the box." };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, message: "Paste the key into the box." };
  if (value.length > 400 || !p.shape.test(value)) return { ok: false, message: `That does not look like a valid ${p.label} key (${p.shapeHint}).` };
  return { ok: true, value };
}

export interface KeyTestRequest {
  url: string;
  method: "GET";
  headers: Record<string, string>;
}

/**
 * The ONE free request used to test a key. Hosts and paths are constants; only the key varies.
 * `custom` has no fixed host (its address is the owner's own), so it has no key test: a key is never sent to a free-form URL here.
 */
export function keyTestRequest(id: ProviderId, key: string): KeyTestRequest | null {
  const bearer = { authorization: `Bearer ${key}` };
  switch (id) {
    case "anthropic":
      return { url: "https://api.anthropic.com/v1/models", method: "GET", headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } };
    case "openai":
      return { url: "https://api.openai.com/v1/models", method: "GET", headers: bearer };
    case "gemini":
      return { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", method: "GET", headers: { "x-goog-api-key": key } };
    case "deepseek":
      return { url: "https://api.deepseek.com/models", method: "GET", headers: bearer };
    case "openrouter":
      return { url: "https://openrouter.ai/api/v1/key", method: "GET", headers: bearer }; // key info: /models is public, so it proves nothing
    case "groq":
      return { url: "https://api.groq.com/openai/v1/models", method: "GET", headers: bearer };
    case "mistral":
      return { url: "https://api.mistral.ai/v1/models", method: "GET", headers: bearer };
    case "xai":
      return { url: "https://api.x.ai/v1/models", method: "GET", headers: bearer };
    case "moonshot":
      return { url: "https://api.moonshot.ai/v1/models", method: "GET", headers: bearer };
    case "qwen":
      return { url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models", method: "GET", headers: bearer };
    case "together":
      return { url: "https://api.together.ai/v1/models", method: "GET", headers: bearer };
    case "siliconflow":
      return { url: "https://api.siliconflow.com/v1/models", method: "GET", headers: bearer };
    case "custom":
      return null;
    case "elevenlabs":
      return { url: "https://api.elevenlabs.io/v1/models", method: "GET", headers: { "xi-api-key": key } };
    case "google_tts":
      return { url: "https://texttospeech.googleapis.com/v1/voices", method: "GET", headers: { "x-goog-api-key": key } }; // list voices: free
    case "azure_speech": // region-specific host, no free request without it
    case "coverr":
    case "fal":
    case "voicestudio": // owner's own address: a key is never sent to a free-form URL here
    case "local_voice":
      return null; // "checked on first use"
    case "pexels":
      return { url: "https://api.pexels.com/v1/curated?per_page=1", method: "GET", headers: { authorization: key } };
    case "pixabay": {
      const u = new URL("https://pixabay.com/api/");
      u.searchParams.set("key", key); // Pixabay accepts the key only as a query parameter
      u.searchParams.set("per_page", "3");
      return { url: u.toString(), method: "GET", headers: {} };
    }
  }
}

/** Only a clear yes (2xx) or a clear no (401/403) is a verdict; anything else says nothing about the key. */
export function statusToResult(status: number): KeyTestResult {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "rejected";
  return "unreachable";
}

export type VaultState = "ok" | "missing_key" | "wrong_key" | "unreadable";

/** Fail closed: anything but a vault that opens with the loaded key disables saving and says why. */
export function vaultNotice(state: VaultState): { canSave: boolean; message: string | null } {
  switch (state) {
    case "ok":
      return { canSave: true, message: null };
    case "missing_key":
      return { canSave: false, message: "The vault master key is missing. Set VAULT_MASTER_KEY in .env.local (run npm run vault:init on a new machine), then restart the app. Saving is off until then." };
    case "wrong_key":
      return { canSave: false, message: "VAULT_MASTER_KEY does not match the key that sealed the stored keys. Restore the right key in .env.local and restart. Saving is off so nothing is overwritten." };
    case "unreadable":
      return { canSave: false, message: "A stored vault entry could not be read. Run npm run vault:check. Saving is off until the vault is healthy." };
  }
}
