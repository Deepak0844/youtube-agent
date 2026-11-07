// Pure helpers for the real notification senders (Doc 04 5). No IO.
import ipaddr from "ipaddr.js";
import { classifyAddress } from "@/server/core/net-policy";

/** Text for a desktop popup: control characters and newlines flattened, length capped. Quotes need no escaping because the text travels as an argument, never inside script source. */
export function popupText(s: string, max = 200): string {
  const flat = Array.from(s, (ch) => {
    const c = ch.charCodeAt(0);
    return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ? " " : ch;
  }).join("");
  return flat.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Fixed AppleScript; title and body arrive as argv items 1 and 2. Nothing from the studio is ever spliced into this source. */
export const OSASCRIPT_SOURCE = "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run";

export function osascriptArgs(title: string, text: string): string[] {
  return ["-e", OSASCRIPT_SOURCE, popupText(title, 100) || "YT Studio", popupText(text) || " "];
}

/** null when the address may be saved; otherwise a fixed sentence. Literal private/loopback hosts are refused here; names are checked again when sending (safeFetch resolves them). */
export function checkWebhookUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "That is not a web address."; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Use an http or https address.";
  if (u.username || u.password) return "Put no username or password in the address.";
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return "Private and local addresses are not allowed.";
  const looksIp = ipaddr.isValid(host) || /^[0-9a-fx.]+$/i.test(host);
  if (looksIp && classifyAddress(host) !== "public") return "Private and local addresses are not allowed.";
  return null;
}
