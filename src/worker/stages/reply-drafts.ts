import type { Message } from "@/server/core/agent-loop";
import { replyMessages, validateReplies } from "@/server/core/comments";
import { langName } from "@/server/core/lang";
import { KnownFailure } from "@/server/core/paid-call";
import { parseJson, withRetries } from "@/server/core/scene-build";
import { loadDraftInput, saveDrafts } from "@/server/db/comments";
import type { AttemptHandler } from "./attempt";
import { loadVideo, videoMoneyScopes, type StageDeps } from "./deps";

/**
 * On demand: drafts replies to a video's NEW comments through the 'comment_replies' model route (Claude Code, text only).
 * Comment text reaches the model only as fenced, quoted data and the prompt holds no secret. A draft never posts itself: every
 * draft is saved HELD for the owner. A rejected answer goes back once or twice with the problem list; only a passing answer is saved.
 */
export function replyDraftsAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    if (!deps.makeLlm) throw new KnownFailure("No model is wired, so replies cannot be drafted.");
    const video = await loadVideo(deps.db, ctx);
    const input = await loadDraftInput(deps.db, video.id);
    if (!input || input.comments.length === 0) return { files: [], result: { drafted: 0 } };
    const asked = new Set(input.comments.map((c) => c.id));
    const llm = deps.makeLlm(await videoMoneyScopes(deps.db, video));
    const ask = async (messages: Message[]) => (await llm.agent(ctx, { stage: "comment_replies", tools: [], messages, maxSteps: 1, maxOutputTokens: 2500 })).text;
    const res = await withRetries(ask, replyMessages({ langName: langName(input.lang), topic: input.topic, comments: input.comments }), (text) => {
      const raw = parseJson(text);
      if (raw === undefined) return { ok: false, errors: ["The answer was not valid JSON."] };
      const v = validateReplies(raw, asked, input.lang);
      return v.ok ? { ok: true, value: v.replies } : { ok: false, errors: v.errors };
    });
    if ("errors" in res) throw new KnownFailure(`reply_drafts_invalid: ${res.errors.join("; ")}`.slice(0, 600));
    const drafted = await saveDrafts(deps.db, video.id, res.value);
    return { files: [], result: { drafted } };
  };
}
