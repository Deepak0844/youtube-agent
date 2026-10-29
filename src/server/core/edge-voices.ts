import type { Lang } from "./lang";

// Default Microsoft Edge neural voice per language (names from the public Edge read-aloud voice list).
export const EDGE_VOICES: Record<Lang, string> = {
  en: "en-US-AriaNeural",
  hi: "hi-IN-SwaraNeural",
  ta: "ta-IN-PallaviNeural",
  te: "te-IN-ShrutiNeural",
  ml: "ml-IN-SobhanaNeural",
  kn: "kn-IN-SapnaNeural",
};
