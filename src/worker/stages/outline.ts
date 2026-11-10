import { outlineMessages, OUTLINE_MAX_OUTPUT_TOKENS } from "@/server/authoring/outline";
import type { Message } from "@/server/core/agent-loop";
import { isLang } from "@/server/core/lang";
import { validateOutline } from "@/server/core/long-form";
import { KnownFailure } from "@/server/core/paid-call";
import { parseJson, withRetries } from "@/server/core/scene-build";
import { pendingOutlineFeedback } from "@/server/db/draft-store";
import type { AttemptHandler } from "./attempt";
import { loadVideo, videoMoneyScopes, type StageDeps } from "./deps";

/**
 * Outline (long videos only): one reserved model call through the 'outline' route plans 3 to 6 chapters (title, one line, seconds)
 * inside the video's own length range. Nothing else is spent here and nothing runs after it until the owner approves the outline.
 * The money counts against the video's cap (the long-video cap) and the day and month caps, exactly like Build. A rejected answer
 * goes back with the problem list (max 2 retries); only a valid outline is saved.
 */
export function outlineAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    if (!deps.makeLlm) throw new KnownFailure("No model is wired, so the outline cannot be written.");
    const video = await loadVideo(deps.db, ctx);
    if (video.format !== "long") throw new KnownFailure("Only a long video has an outline step.");
    const r = await deps.db.query<{ topic: string; notes: string | null; length_min_minutes: number | null; length_max_minutes: number | null }>("select topic, notes, length_min_minutes, length_max_minutes from videos where id = $1", [video.id]);
    const v = r.rows[0];
    if (!v || v.length_min_minutes === null || v.length_max_minutes === null) throw new KnownFailure("This long video has no length range saved.");
    if (!isLang(video.language)) throw new KnownFailure("This video has an unknown language.");
    const range = { min: v.length_min_minutes, max: v.length_max_minutes };
    const feedback = await pendingOutlineFeedback(deps.db, video.id);
    const llm = deps.makeLlm(await videoMoneyScopes(deps.db, video));
    const ask = async (messages: Message[]) => (await llm.agent(ctx, { stage: "outline", tools: [], messages, maxSteps: 1, maxOutputTokens: OUTLINE_MAX_OUTPUT_TOKENS })).text;
    const res = await withRetries(ask, outlineMessages({ topic: v.topic, lang: video.language, range, ...(v.notes ? { notes: v.notes } : {}), ...(feedback ? { feedback } : {}) }), (text) => {
      const raw = parseJson(text);
      if (raw === undefined) return { ok: false, errors: ["The answer was not valid JSON."] };
      const o = validateOutline(raw, range);
      return o.ok ? { ok: true, value: o.outline } : { ok: false, errors: o.problems };
    });
    if ("errors" in res) throw new KnownFailure(`outline_invalid: ${res.errors.join("; ")}`.slice(0, 600));
    return { files: [], content: [{ kind: "outline", body: res.value }], result: { chapters: res.value.chapters.length } };
  };
}
