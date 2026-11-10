import { KnownFailure } from "@/server/core/paid-call";
import { getAsset } from "@/server/db/assets";
import { latestContent } from "@/server/db/videos";
import type { AttemptHandler } from "./attempt";
import { loadVideo, type StageDeps } from "./deps";

/** The title the card shows: the saved upload title, else the first title option, else the topic. Never empty. */
export async function thumbnailTitleFor(db: StageDeps["db"], videoId: string, topic: string): Promise<string> {
  const meta = (await latestContent(db, videoId, "metadata"))?.body as { title?: unknown } | null | undefined;
  if (typeof meta?.title === "string" && meta.title.trim() !== "") return meta.title.trim();
  const titles = (await latestContent(db, videoId, "titles"))?.body as { options?: Array<{ text?: unknown }> } | null | undefined;
  const first = titles?.options?.[0]?.text;
  return typeof first === "string" && first.trim() !== "" ? first.trim() : topic;
}

/**
 * On demand (never in the route): draws the 1280x720 thumbnail card of a LONG video in the render sandbox. The title comes from the video;
 * the owner may name one of their own pictures (an image asset) that goes on the card. Free, local, no model call. The card is promoted as
 * thumbnail.png (a second run replaces it) and saved as a new `thumbnail` content version; the thumbnail gate hashes exactly that.
 */
export function thumbnailAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    if (!deps.thumbnails) throw new KnownFailure("No renderer is wired, so the thumbnail cannot be drawn.");
    const video = await loadVideo(deps.db, ctx);
    if (video.format !== "long") throw new KnownFailure("Only a long video has a thumbnail step.");
    const req = await deps.db.query<{ result: { request?: { assetId?: unknown } } | null }>("select result from stage_runs where id = $1", [ctx.claim.stageRunId]);
    const assetId = req.rows[0]?.result?.request?.assetId;
    let pictureRef: string | undefined;
    if (assetId !== undefined && assetId !== null) {
      const a = typeof assetId === "string" ? await getAsset(deps.db, assetId) : null;
      if (!a || a.deletedAt || a.kind !== "image") throw new KnownFailure("The picture chosen for the thumbnail no longer exists or is not an image. Pick another one.");
      pictureRef = a.storageRef;
    }
    const topic = (await deps.db.query<{ topic: string }>("select topic from videos where id = $1", [video.id])).rows[0]?.topic ?? "";
    const title = await thumbnailTitleFor(deps.db, video.id, topic);
    const r = await deps.thumbnails.draw(ctx, { title, seed: video.id, ...(pictureRef ? { pictureRef } : {}), outFile: "thumbnail.png" });
    return { files: ["thumbnail.png"], content: [{ kind: "thumbnail", file: "thumbnail.png" }], result: { thumbnail: "thumbnail.png", picture: pictureRef ? "own" : "none", image: r.image } };
  };
}
