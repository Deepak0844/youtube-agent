import type { Message } from "@/server/core/agent-loop";
import { KnownFailure } from "@/server/core/paid-call";
import { parseJson, withRetries } from "@/server/core/scene-build";
import { seoMessages, validateSeo, type SeoContext } from "@/server/core/seo";
import { approvedScript } from "@/server/db/stage-content";
import type { AttemptHandler } from "./attempt";
import { loadVideo, videoMoneyScopes, type StageDeps } from "./deps";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * On demand (never in the route, not in the hash chain): writes titles, description, tags and a pinned-comment idea for the
 * APPROVED script, through the 'titles' model route. Same reserved, budget-scoped call as Build; a refusal or an unclear
 * outcome goes up untouched. A rejected answer goes back with the problem list (max 2 retries). Only a passing answer is saved.
 */
export function seoAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    if (!deps.makeLlm) throw new KnownFailure("No model is wired, so titles cannot be written.");
    const video = await loadVideo(deps.db, ctx);
    const script = await approvedScript(deps.db, video.id);
    if (!script.ok) throw new KnownFailure(script.reason);
    const claims = Array.isArray(script.script.evidence) ? (script.script.evidence as Array<Record<string, unknown>>) : [];
    const sc: SeoContext = {
      lang: video.language,
      format: video.format,
      narration: str(script.script.narration),
      beatTexts: script.beats.map((b) => str((b as { text?: unknown }).text)),
      sources: [...new Set(claims.filter((c) => c.kind === "sourced").map((c) => str(c.source_url)).filter(Boolean))],
      scriptHash: script.hash,
    };
    const t = await deps.db.query<{ topic: string }>("select topic from videos where id = $1", [video.id]);
    const llm = deps.makeLlm(await videoMoneyScopes(deps.db, video));
    const ask = async (messages: Message[]) => (await llm.agent(ctx, { stage: "titles", tools: [], messages, maxSteps: 1, maxOutputTokens: 1500 })).text;
    const res = await withRetries(ask, seoMessages(sc, t.rows[0]?.topic ?? str(script.script.title)), (text) => {
      const raw = parseJson(text);
      if (raw === undefined) return { ok: false, errors: ["The answer was not valid JSON."] };
      const v = validateSeo(raw, sc);
      return v.ok ? { ok: true, value: v.body } : { ok: false, errors: v.problems };
    });
    if ("errors" in res) throw new KnownFailure(`seo_invalid: ${res.errors.join("; ")}`.slice(0, 600));
    return { files: [], content: [{ kind: "titles", body: res.value }], result: { titles: res.value.options.length } };
  };
}
