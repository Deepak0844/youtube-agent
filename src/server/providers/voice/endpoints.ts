import { REGION } from "./azure";
import { assertVoiceStudioUrl, isLoopbackHost, VoiceUrlError } from "./voicestudio";

// Owner-typed voice server settings, checked with the SAME rules the voice stage applies when it runs (voice-for.ts).
// Pure. Refusals are fixed sentences; the typed text is quoted back only as a short clip.

export const VOICE_FIELDS = {
  voicestudio_url: { key: "voice.voicestudio_url", slot: "voicestudio" },
  local_url: { key: "voice.local_url", slot: "local_voice" },
  azure_region: { key: "voice.azure_region", slot: null },
} as const;
export type VoiceField = keyof typeof VOICE_FIELDS;
export const isVoiceField = (f: unknown): f is VoiceField => typeof f === "string" && Object.hasOwn(VOICE_FIELDS, f);

export type VoiceCheck = { ok: true; value: string } | { ok: false; error: string };

/** Empty clears the setting. `hasKey` = a key is saved for this server (the rules differ for another computer). */
export function checkVoiceField(field: VoiceField, raw: string, hasKey: boolean): VoiceCheck {
  const value = raw.trim();
  if (value === "") return { ok: true, value };
  if (value.length > 300 || /[\x00-\x20\x7f]/.test(value)) return { ok: false, error: "That is not a valid address." };
  if (field === "azure_region") {
    return REGION.test(value) ? { ok: true, value } : { ok: false, error: "That is not an Azure region. Use letters, digits and hyphens, like westeurope." };
  }
  try {
    // A base address only: no user name, password, path, query or fragment, so no secret can sit in a saved address or the audit.
    const base = new URL(value);
    if (base.username !== "" || base.password !== "") throw new VoiceUrlError("The address must not contain a user name or password.");
    if (base.search !== "" || base.hash !== "" || (base.pathname !== "" && base.pathname !== "/")) {
      throw new VoiceUrlError("The address must be just the server, like http://127.0.0.1:3900, with no path, ? or #.");
    }
    if (field === "voicestudio_url") assertVoiceStudioUrl(value, hasKey);
    else {
      const u = new URL(value);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new VoiceUrlError("The address must start with http:// or https://.");
      if (u.username !== "" || u.password !== "") throw new VoiceUrlError("The address must not contain a user name or password.");
      if (hasKey && u.protocol !== "https:" && !isLoopbackHost(u.hostname)) {
        throw new VoiceUrlError("A key must not be sent over plain http to another computer. Use an https address.");
      }
    }
  } catch (e) {
    const msg = e instanceof VoiceUrlError ? e.message : "That is not a valid URL, like http://127.0.0.1:3900.";
    return { ok: false, error: msg };
  }
  return { ok: true, value };
}

/** The `host:port` the safe fetcher looks up in the local-services list for this address, or null if it is not a URL. */
export function hostPortOf(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.hostname.toLowerCase()}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return null;
  }
}
