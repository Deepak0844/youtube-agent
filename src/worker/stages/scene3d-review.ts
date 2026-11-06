import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import { lookProblems, stillMetrics } from "@/server/core/scene3d-look-check";
import { readSceneCodeBody, sceneCodeSha } from "@/server/core/scene3d-code-body";
import { decideReview, type ReviewBody } from "@/server/core/scene3d-review";
import { readPreviews } from "@/server/core/scene3d-stills";
import { activeReviewOf, lookSendBackCount } from "@/server/db/review-state";
import { latestContent } from "@/server/db/videos";
import { decodeStill } from "@/server/render/still-pixels";
import { openRegular, promotedPath, type AttemptHandler } from "./attempt";
import { loadVideo, scopeHeadroom, videoMoneyScopes, type StageDeps } from "./deps";

/**
 * The most one author call can cost, as far as this video has shown: the largest amount any earlier author call reserved. Zero when there
 * was none yet (the first call is checked by its own reservation anyway).
 */
async function authorCallEstimate(deps: StageDeps, videoId: string): Promise<number> {
  const r = await deps.db.query<{ m: string | null }>(
    "select max(si.reserved_micro_usd)::text as m from spend_intents si join stage_runs sr on sr.id = si.stage_run_id where sr.video_id = $1 and sr.name = 'scene3d_author'",
    [videoId],
  );
  return Number(r.rows[0]?.m ?? 0);
}

/** True when the money left for this video (its own cap, today and this month) can pay for one more author call. Unknown caps count as "no": the loop never spends on a guess. */
async function budgetAllowsAnotherRound(deps: StageDeps, video: Awaited<ReturnType<typeof loadVideo>>): Promise<boolean> {
  try {
    const room = await scopeHeadroom(deps.db, await videoMoneyScopes(deps.db, video));
    return room.micro >= (await authorCallEstimate(deps, video.id));
  } catch {
    return false;
  }
}

/**
 * scene3d_review: after the preview pictures of an AI-written scene are drawn, check them without any model (flat or empty frames, a white
 * void, a cut-off subject, the declared hero), add the picture-check notes already saved with the pictures, and decide: pass, or ask the
 * author for another revision (at most 3, and only while the budget can pay for it). At the end the BEST scene seen is the one on the Look card.
 * Saves content `review`; when the loop stopped on a worse scene it also puts the better one back (`scenes` + scene.tsx).
 */
export function scene3dReviewAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    if (video.kind !== "scene3d_code") throw new KnownFailure("Only a 3D story with an AI-written scene has an automatic picture review.");
    const scenes = await latestContent(deps.db, video.id, "scenes");
    const scene = readSceneCodeBody(scenes?.body);
    if (!scene) throw new KnownFailure("The stored scene code is missing or damaged. Run the author step again.");
    const previewsRow = await latestContent(deps.db, video.id, "previews");
    const previews = readPreviews(previewsRow?.body);
    if (!previews) throw new KnownFailure("The preview pictures are missing or unreadable. Run the preview step again.");
    if (previews.scene_sha256 !== sceneCodeSha(scene.source, scene.props)) throw new KnownFailure("The preview pictures are not of the newest scene. Run the preview step again.");
    const narrationSha = (await latestContent(deps.db, video.id, "narration"))?.sha256;
    if (!narrationSha) throw new KnownFailure("The narration is missing. Run the voice step again.");

    const metrics = [];
    for (const [i, s] of previews.stills.entries()) {
      try {
        const fh = await openRegular(await promotedPath(deps.root, video.id, s.file));
        let bytes: Buffer;
        try {
          bytes = await readFile(fh);
        } finally {
          await fh.close();
        }
        metrics.push(stillMetrics(await decodeStill(new Uint8Array(bytes))));
      } catch {
        throw new KnownFailure(`Preview picture ${i + 1} could not be read for the check. Run the preview step again.`);
      }
    }
    const problems = lookProblems(metrics, previews.hero ?? null);
    const advice = previews.advice.status === "done" ? previews.advice.notes : [];

    const prior = await activeReviewOf(deps.db, video.id);
    const lookCount = await lookSendBackCount(deps.db, video.id);
    // Only worth looking at the money when another round could actually follow.
    const nextRound = prior && prior.revise ? prior.round + 1 : 0;
    const budgetOk = problems.length === 0 || nextRound >= 3 ? true : await budgetAllowsAnotherRound(deps, video);
    let review: ReviewBody = decideReview(prior, { sceneSha256: scene.source_sha256, problems, advice, lookCount, narrationSha, budgetOk });

    const files: string[] = [];
    const content: Array<{ kind: "scenes" | "review"; body: unknown }> = [];
    if (review.restore_sha256 !== null) {
      // The loop stopped on a scene that is worse than an earlier one: put the better scene back (a new newest `scenes` version and scene.tsx).
      const hit = await deps.db.query<{ body: unknown }>("select body from video_content where video_id = $1 and kind = 'scenes' and body->>'source_sha256' = $2 order by version desc limit 1", [video.id, review.restore_sha256]);
      const better = readSceneCodeBody(hit.rows[0]?.body);
      if (better && better.source_sha256 === review.restore_sha256) {
        await writeFile(path.join(ctx.attemptDir, "scene.tsx"), better.source, { mode: 0o600 });
        files.push("scene.tsx");
        content.push({ kind: "scenes", body: better });
      } else {
        review = { ...review, restore_sha256: null, best_round: review.round }; // cannot find it: keep what is here, honestly
      }
    }
    content.push({ kind: "review", body: review });
    ctx.log(`review: round ${review.round}, ${problems.length} problem${problems.length === 1 ? "" : "s"}${review.revise ? ", asking for a revision" : review.stop_reason ? `, stop (${review.stop_reason})` : ""}${review.restore_sha256 ? `, putting back round ${review.best_round}` : ""}`);
    return { files, content, result: { kind: "scene3d_review", round: review.round, problems: problems.length, revise: review.revise, stop: review.stop_reason, best_round: review.best_round } };
  };
}
