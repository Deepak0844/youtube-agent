import type { ModelStep, StepResult } from "@/server/core/agent-loop";
import { wordRange, type Lang } from "@/server/core/lang";

// Deterministic ModelStep for tests: no network, no randomness. With no script it answers every call with a valid
// Draft script in the requested language (word count in the middle of the allowed range, computed evidence only, so
// it never invents a source). With a script it plays the entries in order (an Error is thrown) and repeats the last.

const WORD: Record<Lang, string> = { en: "word", hi: "शब्द", ta: "சொல்", te: "పదం", ml: "വാക്ക്", kn: "ಪದ" };
const TITLE: Record<Lang, string> = { en: "A short test video", hi: "एक छोटा परीक्षण वीडियो", ta: "ஒரு சிறிய சோதனை வீடியோ", te: "ఒక చిన్న పరీక్ష వీడియో", ml: "ഒരു ചെറിയ പരീക്ഷണ വീഡിയോ", kn: "ಒಂದು ಚಿಕ್ಕ ಪರೀಕ್ಷಾ ವೀಡಿಯೊ" };

export function fakeDraft(lang: Lang): object {
  const { min, max } = wordRange(lang);
  const n = Math.round((min + max) / 2);
  const narration = Array.from({ length: n }, () => WORD[lang]).join(" ");
  return {
    title: TITLE[lang],
    narration,
    beats: [{ id: "b1", text: narration }],
    evidence: [{ text: "2 + 2 = 4", kind: "computed", method: "add the two numbers" }],
  };
}

export function fakeModelStep(opts: { lang?: Lang; script?: Array<StepResult | Error> } = {}): ModelStep {
  const lang = opts.lang ?? "en";
  const script = opts.script ?? [];
  let n = 0;
  return async (_messages, _idempotencyKey, signal) => {
    if (signal?.aborted) throw signal.reason;
    if (script.length === 0) {
      const text = JSON.stringify(fakeDraft(lang));
      return { text, toolCalls: [], usage: { inputTokens: 100, outputTokens: Math.ceil(text.length / 4) } };
    }
    const next = script[Math.min(n, script.length - 1)]!;
    n += 1;
    if (next instanceof Error) throw next;
    return next;
  };
}
