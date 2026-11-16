import ipaddr from "ipaddr.js";
import { KnownFailure } from "@/server/core/paid-call";

// Owner-typed voice server addresses and settings, and the "is this address this computer?" rule behind them. Pure: no IO. The voice
// stage (voice-for.ts) and the settings screens apply the SAME rules, so they live here, below both.

export class VoiceUrlError extends KnownFailure {
  constructor(message: string) {
    super(message);
    this.name = "VoiceUrlError";
  }
}

/**
 * "This computer": loopback, or host.docker.internal inside the app's own container (YTSTUDIO_IN_CONTAINER, set by its image), where the
 * container's hosts file pins that name to the Docker host. Elsewhere the name would come from ordinary DNS, so it is another computer.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (h.toLowerCase() === "localhost") return true;
  if (h.toLowerCase() === "host.docker.internal") return process.env.YTSTUDIO_IN_CONTAINER === "1";
  if (!ipaddr.isValid(h)) return false;
  const a = ipaddr.parse(h);
  return a.kind() === "ipv6" && (a as ipaddr.IPv6).isIPv4MappedAddress() ? false : a.range() === "loopback";
}

/** VoiceStudio has no login of its own on loopback. Anywhere else it must be reached with a key, or it is refused. */
export function assertVoiceStudioUrl(url: string, hasKey: boolean): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new VoiceUrlError("The VoiceStudio address is not a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new VoiceUrlError("The VoiceStudio address must start with http:// or https://.");
  if (u.username !== "" || u.password !== "") throw new VoiceUrlError("The VoiceStudio address must not contain a user name or password.");
  if (hasKey && u.protocol !== "https:" && !isLoopbackHost(u.hostname)) throw new VoiceUrlError("A key must not be sent over plain http to another computer. Use an https address.");
  if (!hasKey && !isLoopbackHost(u.hostname)) {
    throw new VoiceUrlError("VoiceStudio is not on this computer, so an API key is required. Add a key, or use the address 127.0.0.1.");
  }
}

export const REGION = /^[a-z0-9-]{3,30}$/;


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
