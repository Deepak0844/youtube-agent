import type pg from "pg";
import type { Uploader } from "@/server/providers/uploader";
import { THUMBNAIL_PNG_MAX_BYTES } from "@/server/providers/renderer/thumbnail-container";
import { hashStoredFile, openStoredFile } from "@/server/storage/hash-file";
import { storageRoot } from "@/server/storage/paths";
import { approvalState, readSnapshot } from "./approvals";
import { recordAudit } from "./audit";

// After a long video is uploaded, its APPROVED thumbnail is set on YouTube (thumbnails.set, 50 quota units). Only the version
// the owner approved, read now and hash-checked against that version, is sent. It runs once per upload (upload_log
// `thumbnail_set` / `thumbnail_failed: ...`); nothing retries on its own and a failure never touches the uploaded video.

export type ThumbnailResult = "set" | "skipped" | "failed";

async function note(pool: pg.Pool, uploadId: string, event: string): Promise<void> {
  await pool.query("insert into upload_log (upload_id, event) values ($1, $2)", [uploadId, event.slice(0, 300)]).catch(() => undefined);
}

export async function sendApprovedThumbnail(pool: pg.Pool, uploader: Pick<Uploader, "setThumbnail">, uploadId: string, opts: { root?: string; signal?: AbortSignal } = {}): Promise<ThumbnailResult> {
  if (!uploader.setThumbnail) return "skipped";
  const up = (await pool.query<{ video_id: string; youtube_id: string | null; channel_id: string | null; format: string; row_id: string | null }>(
    `select u.video_id, u.youtube_id, u.channel_id, v.format, c.id as row_id
       from uploads u join videos v on v.id = u.video_id left join youtube_channels c on c.channel_id = u.channel_id
      where u.id = $1 and u.status = 'uploaded'`,
    [uploadId],
  )).rows[0];
  if (!up || up.format !== "long" || !up.youtube_id) return "skipped";
  // Claim the one send: a second call (redelivery, a later retry path) finds the claim and stops. Only the upload job calls this, one
  // upload at a time. A crash after the claim leaves `thumbnail_claimed` with no result and nothing is sent again.
  const claim = await pool.query(
    `insert into upload_log (upload_id, event) select $1, 'thumbnail_claimed'
      where not exists (select 1 from upload_log where upload_id = $1 and event = 'thumbnail_claimed')`,
    [uploadId],
  );
  if (!claim.rowCount) return "skipped";
  const fail = async (reason: string): Promise<ThumbnailResult> => {
    await note(pool, uploadId, `thumbnail_failed: ${reason}`);
    await recordAudit(pool, "upload.thumbnail", { uploadId, videoId: up.video_id, ok: false, reason }).catch(() => undefined);
    return "failed";
  };
  if (!up.row_id) return fail("the channel is no longer connected");
  // The approval must still hold for the newest picture: a new card after approving voids it, and nothing unapproved is sent.
  const state = await approvalState(pool, up.video_id, "thumbnail");
  if (!state.approved) return fail("the thumbnail is not approved (or changed after approving)");
  const snap = await readSnapshot(pool, up.video_id, "thumbnail");
  const pic = snap === "no_video" ? undefined : snap.inputs.content.thumbnail;
  if (snap === "no_video" || !snap.live.ok || snap.live.hash !== state.hash || !pic?.filePath) return fail("the approved thumbnail could not be found");
  let png: Buffer;
  try {
    const root = opts.root ?? storageRoot();
    const h = await hashStoredFile(root, pic.filePath, { maxBytes: THUMBNAIL_PNG_MAX_BYTES });
    if (h.sha256 !== pic.sha256) return fail("the thumbnail file changed after it was approved");
    const parts: Buffer[] = [];
    for await (const c of await openStoredFile(root, pic.filePath, h, { maxBytes: THUMBNAIL_PNG_MAX_BYTES })) parts.push(c as Buffer);
    png = Buffer.concat(parts);
  } catch {
    return fail("the approved thumbnail file could not be read");
  }
  const r = await uploader.setThumbnail(up.row_id, up.youtube_id, png, opts.signal ?? AbortSignal.timeout(120_000));
  if (!r.ok) return fail(r.reason);
  await note(pool, uploadId, "thumbnail_set");
  await recordAudit(pool, "upload.thumbnail", { uploadId, videoId: up.video_id, ok: true }).catch(() => undefined);
  return "set";
}
