import type pg from "pg";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { approvalState, liveGateHash } from "./approvals";
import { getAsset, listAssets, type Asset } from "./assets";
import { recordAudit } from "./audit";
import { inTx, type EnqueueOnly } from "./pipeline";
import { mediaSigner } from "./queue-data";
import { latestContent } from "./videos";

export type ThumbnailRequest = { ok: true; stageRunId: string } | { ok: false; message: string };

/**
 * Owner asked for the thumbnail card of a LONG video, optionally with one of their own pictures on it. Only queues the on-demand
 * `thumbnail` stage (free, local, no model call). One run at a time per video; asking again queues a fresh run and a new `thumbnail`
 * content version, which voids an earlier approval by the hash. The chosen picture rides in the run's request, like Re-frame's format.
 */
export async function requestThumbnail(db: pg.Pool, queue: EnqueueOnly, videoId: string, o: { assetId?: string | null; sessionId?: string } = {}): Promise<ThumbnailRequest> {
  const assetId = o.assetId ?? null;
  if (assetId !== null) {
    const a = await getAsset(db, assetId).catch(() => null);
    if (!a || a.deletedAt) return { ok: false, message: "That picture was not found." };
    if (a.kind !== "image") return { ok: false, message: "Pick an image for the thumbnail." };
  }
  const out = await inTx(db, async (c): Promise<ThumbnailRequest & { hash?: string }> => {
    const v = await c.query<{ status: string; format: string }>("select status, format from videos where id = $1 for update", [videoId]);
    if (!v.rows[0]) return { ok: false, message: "That video was not found." };
    if (v.rows[0].status === "cancelled") return { ok: false, message: "This video was cancelled." };
    if (v.rows[0].format !== "long") return { ok: false, message: "Only a long video has a thumbnail step." };
    const busy = await c.query("select 1 from stage_runs where video_id = $1 and name = 'thumbnail' and status in ('queued', 'running', 'needs_decision')", [videoId]);
    if (busy.rowCount) return { ok: false, message: "A thumbnail is already being drawn for this video." };
    const n = await c.query<{ n: string }>("select count(*)::text as n from stage_runs where video_id = $1 and name = 'thumbnail'", [videoId]);
    const hash = sha256Hex(canonicalJson({ stage: "thumbnail", video: videoId, asset: assetId, n: Number(n.rows[0]!.n) }));
    const id = uuidv7();
    const ins = await c.query("insert into stage_runs (id, video_id, name, status, input_hash, result) values ($1, $2, 'thumbnail', 'queued', $3, $4) on conflict do nothing", [id, videoId, hash, JSON.stringify({ request: { assetId } })]);
    if (!ins.rowCount) return { ok: false, message: "A thumbnail was just requested. Look again." };
    return { ok: true, stageRunId: id, hash };
  });
  if (!out.ok) return out;
  await recordAudit(db, "video.thumbnail_requested", { videoId, ownPicture: assetId !== null, stageRunId: out.stageRunId, sessionId: o.sessionId });
  // After the commit. If Redis is down the row stays queued and the reconciler enqueues it.
  await queue.enqueue(out.stageRunId, 0, 0, out.hash!).catch(() => undefined);
  return { ok: true, stageRunId: out.stageRunId };
}

export interface ThumbnailTab {
  /** a card exists */
  hasCard: boolean;
  /** signed link to the card, or null (no card, or the media key is locked) */
  src: string | null;
  /** the hash the owner is looking at: the approve form sends it back */
  seenHash: string | null;
  /** the owner approved exactly this card */
  approved: boolean;
  /** a run is queued or running */
  busy: boolean;
  failed: boolean;
  /** the owner's live image assets to pick from (id and name), newest first */
  pictures: Array<{ id: string; name: string }>;
}

export async function loadThumbnailTab(db: pg.Pool, videoId: string): Promise<ThumbnailTab> {
  const card = await latestContent(db, videoId, "thumbnail");
  const live = card ? await liveGateHash(db, videoId, "thumbnail") : null;
  const sign = card?.filePath ? await mediaSigner(db) : null;
  const busy = await db.query("select 1 from stage_runs where video_id = $1 and name = 'thumbnail' and status in ('queued', 'running', 'needs_decision')", [videoId]);
  const last = await db.query<{ status: string }>("select status from stage_runs where video_id = $1 and name = 'thumbnail' order by created_at desc, id desc limit 1", [videoId]);
  const pics: Asset[] = await listAssets(db, { kind: "image" }, 60);
  return {
    hasCard: card !== null,
    src: card?.filePath ? (sign?.(card.filePath) ?? null) : null,
    seenHash: live?.hash ?? null,
    approved: card !== null && (await approvalState(db, videoId, "thumbnail")).approved,
    busy: (busy.rowCount ?? 0) > 0,
    failed: last.rows[0]?.status === "failed",
    pictures: pics.map((p) => ({ id: p.id, name: p.originalName })),
  };
}
