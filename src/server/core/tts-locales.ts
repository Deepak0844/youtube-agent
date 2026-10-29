import type { Lang } from "./lang";

// Cloud voices speak a locale, not a bare language. Google and Azure share this map.
export const TTS_LOCALES: Record<Lang, string> = { en: "en-US", hi: "hi-IN", ta: "ta-IN", te: "te-IN", ml: "ml-IN", kn: "kn-IN" };

export function ttsLocale(lang: string): string | null {
  return Object.hasOwn(TTS_LOCALES, lang) ? TTS_LOCALES[lang as Lang] : null;
}

/** A voice name is `<locale>-<name>` for the language's own locale; anything else is not a known voice. */
export function isVoiceFor(locale: string, voice: string): boolean {
  return voice.startsWith(`${locale}-`) && /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9-]{1,40}$/.test(voice);
}

/** SSML text: the five XML characters escaped (so a line can never close or add a tag) and XML-illegal control characters dropped. */
export function escapeXml(s: string): string {
  return s.replace(/[\p{Cc}]/gu, (c) => (c === "\t" || c === "\n" || c === "\r" ? c : "")).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export const TOO_LONG = "This line is too long for this voice; split it.";
export const utf8Bytes = (s: string) => Buffer.byteLength(s, "utf8");
