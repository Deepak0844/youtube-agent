import localFont from "next/font/local";

// Self-hosted variable fonts (SIL OFL 1.1; licence texts + SHA-256 in public/fonts/). No Google CDN at runtime.
// Instrument Sans leads for Latin; each Noto face covers one script and is fetched only when a glyph needs it.
// Use weights 400/500/600 only (Doc 3 §4). next/font needs literal options, so each call is spelled out.

export const instrument = localFont({
  src: [{ path: "../../public/fonts/instrument-sans-latin.woff2", weight: "400 700", style: "normal" }],
  variable: "--font-instrument",
  display: "swap",
});
export const notoLatin = localFont({
  src: [{ path: "../../public/fonts/noto-sans-latin.woff2", weight: "400 700", style: "normal" }],
  variable: "--font-noto-latin",
  display: "swap",
  preload: false,
});
export const notoDevanagari = localFont({
  src: [{ path: "../../public/fonts/noto-sans-devanagari.woff2", weight: "400 700", style: "normal" }],
  variable: "--font-noto-devanagari",
  display: "swap",
  preload: false,
});
export const notoTamil = localFont({
  src: [{ path: "../../public/fonts/noto-sans-tamil.woff2", weight: "400 700", style: "normal" }],
  variable: "--font-noto-tamil",
  display: "swap",
  preload: false,
});
export const notoTelugu = localFont({
  src: [{ path: "../../public/fonts/noto-sans-telugu.woff2", weight: "400 700", style: "normal" }],
  variable: "--font-noto-telugu",
  display: "swap",
  preload: false,
});
export const notoMalayalam = localFont({
  src: [{ path: "../../public/fonts/noto-sans-malayalam.woff2", weight: "400 700", style: "normal" }],
  variable: "--font-noto-malayalam",
  display: "swap",
  preload: false,
});
export const notoKannada = localFont({
  src: [{ path: "../../public/fonts/noto-sans-kannada.woff2", weight: "400 700", style: "normal" }],
  variable: "--font-noto-kannada",
  display: "swap",
  preload: false,
});

export const fontVariables = [
  instrument,
  notoLatin,
  notoDevanagari,
  notoTamil,
  notoTelugu,
  notoMalayalam,
  notoKannada,
]
  .map((f) => f.variable)
  .join(" ");
