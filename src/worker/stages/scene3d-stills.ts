import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { logSafe } from "@/server/core/frame-review";
import { BudgetRefusedError, KnownFailure } from "@/server/core/paid-call";
import { adviceMessages, ADVICE_MAX_OUTPUT_TOKENS, buildPreviewsBody, parseAdvice, pickCodeStills, pickStills, type Advice, type StillPick } from "@/server/core/scene3d-stills";
import { isScene3dKind } from "@/server/core/pipeline-plan";
import { sceneCodeSha } from "@/server/core/scene3d-code-body";
import { UnpricedCallError } from "@/server/core/spend";
import { LlmRefusal, type LlmClient, type LlmStageContext } from "@/server/llm/client";
import { contentBody, loadVideo, videoMoneyScopes, type StageDeps } from "./deps";
import { openRegular, promotedPath, sha256File, type AttemptHandler } from "./attempt";
import { loadRetimedScene3d, loadSceneCode, nativeOnly } from "./render";

// Preview pictures of a 3D story (Phase 5d slice D2): after the narration exists, the scene is retimed to it (the same function Render
// uses), 6 to 8 moments are drawn natively at 540x960, and the optional picture check (the review_frames vision route, advisory only)
// adds notes. The pictures and the notes are saved as content `previews`; the owner approves the look from them before Render runs.

const SKIP_NO_VISION = "picture check skipped: no vision model";

/**
 * The advisory picture check. NEVER fails the stage and never blocks the gate: no route, no price, no budget or an unreadable answer give a
 * skipped/unavailable note. Only an unclear paid outcome, a cancel or a lost lease go up untouched (the owner decides).
 */
export async function adviceFor(llm: LlmClient | null, ctx: LlmStageContext, picks: readonly StillPick[], pngs: readonly Uint8Array[], topic?: string): Promise<Advice> {
  if (!llm) return { status: "skipped", reason: SKIP_NO_VISION };
  const why = (await llm.routeProblem?.("review_frames")) ?? null;
  if (why !== null) return { status: "skipped", reason: `${SKIP_NO_VISION} (${logSafe(why)})` };
  try {
    const r = await llm.vision(ctx, {
      stage: "review_frames",
      messages: adviceMessages(picks.map((p) => ({ shotId: p.shotId, caption: p.caption })), topic),
      images: pngs.map((data) => ({ data, mediaType: "image/png" as const })),
      maxOutputTokens: ADVICE_MAX_OUTPUT_TOKENS,
    });
    return parseAdvice(r.text);
  } catch (err) {
    if (err instanceof LlmRefusal) return { status: "skipped", reason: `${SKIP_NO_VISION} (${logSafe(err.message)})` };
    if (err instanceof UnpricedCallError) return { status: "skipped", reason: "picture check skipped: the vision model has no usable price" };
    if (err instanceof BudgetRefusedError) return { status: "skipped", reason: "picture check skipped: it does not fit in what is left of the budget for this video" };
    if (err instanceof KnownFailure) return { status: "unavailable", reason: `picture check unavailable: the model call failed (${logSafe(err.message)}); nothing was charged` };
    throw err; // an unclear paid outcome, a cancel, a lost lease: never swallowed, never retried
  }
}

export function scene3dStillsAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    if (!isScene3dKind(video.kind)) throw new KnownFailure("Only 3D story videos have preview pictures.");
    await nativeOnly(deps, ctx, "Preview pictures"); // refuses at once, naming render.native_3d, when native is off or not ready
    const stills = deps.native?.stills;
    if (!stills) throw new KnownFailure("Turn on render.native_3d and run \"npx remotion browser ensure\" first: this worker has no native preview renderer. Nothing was drawn.");

    const narration = await contentBody<{ file?: unknown }>(deps.db, video.id, "narration");
    if (typeof narration.file !== "string") throw new KnownFailure("The narration record has no audio file. Run the voice step again.");
    const audioFile = await promotedPath(deps.root, video.id, narration.file);
    if (!(await lstat(audioFile).catch(() => null))?.isFile()) throw new KnownFailure(`The file ${narration.file} from an earlier stage is missing. Run that stage again.`);

    // scene3d: the director's scene, re-timed to the narration. scene3d_code: the AI-written source with its host-built props (both already checked and fingerprinted).
    let picks: StillPick[];
    let sceneSha: string;
    let drawn: Awaited<ReturnType<typeof stills.stills>>;
    if (video.kind === "scene3d_code") {
      const body = await loadSceneCode(deps, video);
      sceneSha = sceneCodeSha(body.source, body.props);
      picks = pickCodeStills(body.props);
      if (picks.length === 0) throw new KnownFailure("The scene has no story beats to draw. Run the author step again.");
      drawn = await stills.stills(ctx, { scene3dCode: { source: body.source, props: body.props, expectedSha256: sceneSha }, frames: picks.map((p) => p.frame) });
    } else {
      const { scene } = await loadRetimedScene3d(deps, ctx, video, audioFile);
      sceneSha = sha256Hex(canonicalJson(scene));
      picks = pickStills(scene);
      drawn = await stills.stills(ctx, { scene3d: scene, frames: picks.map((p) => p.frame) });
    }
    const r = drawn;
    if (r.files.length !== picks.length) throw new KnownFailure("The preview renderer returned the wrong number of pictures. Nothing was saved.");

    const shas: string[] = [];
    const pngs: Uint8Array[] = [];
    for (const f of r.files) {
      const abs = path.join(ctx.attemptDir, f);
      shas.push(await sha256File(abs));
      const fh = await openRegular(abs);
      try {
        pngs.push(new Uint8Array(await readFile(fh)));
      } finally {
        await fh.close();
      }
    }

    let advice: Advice = { status: "skipped", reason: SKIP_NO_VISION };
    if (deps.makeLlm) {
      const llm = deps.makeLlm(await videoMoneyScopes(deps.db, video));
      const topic = (await deps.db.query<{ topic: string }>("select topic from videos where id = $1", [video.id])).rows[0]?.topic;
      advice = await adviceFor(llm, ctx, picks, pngs, topic);
    }
    ctx.log(`previews: ${picks.length} pictures drawn; picture check: ${advice.status}`);
    const body = buildPreviewsBody({ sceneSha256: sceneSha, picks, shas, advice, hero: r.hero });
    return { files: r.files, content: [{ kind: "previews", body }], result: { kind: "scene3d_previews", stills: picks.length, advice: advice.status, image: r.image ?? null } };
  };
}
