import type { Lang } from "@/server/core/lang";
import { draftSystem, writeBlocks } from "@/server/authoring/draft/prompts";

// The prompt of a research run that writes a Short's script (D3). It reuses the paid draft's own rules and JSON shape (same words,
// same contract) and changes only how the work is done: the app's web tools, a file, check_script. Everything the owner typed is
// DATA inside a fence. Pure: no IO.

export interface ScriptRequestInput {
  topic: string;
  lang: Lang;
  kind: "tsx" | "collage" | "ai";
  notes?: string;
  feedback?: string;
  learning?: string[];
}

export function scriptRequest(v: ScriptRequestInput): { prompt: string } {
  const i = { topic: v.topic, lang: v.lang, kind: v.kind, format: "short" as const, notes: v.notes, feedback: v.feedback, learning: v.learning };
  const prompt = `${draftSystem(i)}

HOW YOU WORK IN THIS RUN (this replaces "Reply with ONLY JSON" and "the excerpts you were given" above):
- Use the write-script skill.
- Find sources with web_search and read pages with web_fetch (a URL web_search returned, at most 6 pages). Cite only pages you fetched.
- Write the script as JSON, in the shape above, to draft/script.json. Then run check_script and fix what it lists until it passes.
- Optional: draft/suggestion.json with {"kind": "tsx" | "collage" | "ai", "reason": "<one sentence>"} when the topic clearly suits a type.
- Write no other file. When check_script passes, reply with one short sentence.

${writeBlocks(i)}`;
  return { prompt };
}
