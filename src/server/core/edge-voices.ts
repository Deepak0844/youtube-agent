import type { Lang } from "./lang";

// Default Microsoft Edge neural voice per language (names from the public Edge read-aloud voice list).
export const EDGE_VOICES: Record<Lang, string> = {
  en: "en-IN-NeerjaExpressiveNeural",
  hi: "hi-IN-SwaraNeural",
  ta: "ta-IN-PallaviNeural",
  te: "te-IN-ShrutiNeural",
  ml: "ml-IN-SobhanaNeural",
  kn: "kn-IN-SapnaNeural",
};

/** Voices the app accepts: the defaults above, plus the earlier English default so routes saved before the change keep working. */
export const EDGE_ALLOWED: readonly string[] = [...Object.values(EDGE_VOICES), "en-US-AriaNeural"];
