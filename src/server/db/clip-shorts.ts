import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import type { ClipBatchBody } from "@/server/core/clip-batch";
import { inheritClipScript } from "@/server/core/clip-inherit";
import { claimsOf } from "@/server/core/evidence-edit";
import { uuidv7 } from "@/server/core/ids";
import { copyRegular } from "@/server/providers/renderer/remotion-container";
import { safeJoin } from "@/server/storage/paths";
import { approvalReaders } from "./approval-readers";
import { recordAudit } from "./audit";
import { advanceVideo, type EnqueueOnly } from "./pipeline";
import { addContent, latestContent, type ContentKind } from "./videos";

export interface ClipShortsResult {
  created: Array<{ clipId: string; videoId: string }>;
  skipped: Array<{ clipId: string; reason: string }>;
}

const MAX_CLIPS_PER_REQUEST = 10;

/**
 * The owner chose clips from a batch (Clip Factory, CF4b-2). Each chosen clip becomes its OWN Short, waiting at the normal gates: the
 * owner approves its inherited script, QA checks the clip file, then the usual video, evidence and publish gates apply. Nothing is
 * approved, verified or published here, and no gate or approval code is changed. A clip is made into a Short once (a second request
 * for it is skipped); dropping a clip means not choosing it, or cancelling its Short later.
 *
 * The caller (the owner's server action) must require a signed-in session: this function does not check one.
 */
export async function createClipShorts(
  db: pg.Pool,
  queue: EnqueueOnly,
  a: { root: string; sourceVideoId: string; batch: number; clipIds: readonly string[]; sessionId?: string },
): Promise<({ ok: true } & ClipShortsResult) | { ok: false; message: string }> {
  const ids = [...new Set(a.clipIds)];
  if (ids.length === 0) return { ok: false, message: "Choose at least one clip." };
  if (ids.length > MAX_CLIPS_PER_REQUEST) return { ok: false, message: `Choose at most ${MAX_CLIPS_PER_REQUEST} clips at a time.` };
  const src = (await db.query<{ status: string; language: string; style: string | null; caption_style: string | null; channel_id: string | null }>(
    "select status, language, style, caption_style, channel_id from videos where id = $1",
    [a.sourceVideoId],
  ).catch(() => ({ rows: [] }))).rows[0];
  if (!src) return { ok: false, message: "That video was not found." };
  if (src.status === "cancelled") return { ok: false, message: "This video was cancelled." };
  const batch = (await latestContent(db, a.sourceVideoId, "clip_batch"))?.body as ClipBatchBody | undefined;
  if (!batch || batch.batch !== a.batch) return { ok: false, message: "That batch is no longer the latest one. Reload the page." };
  const byId = new Map(batch.clips.map((c) => [c.id, c]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) return { ok: false, message: "A chosen clip is not in this batch. Reload the page." };
  const claims = claimsOf((await latestContent(db, a.sourceVideoId, "evidence"))?.body) ?? [];
  const sourceCaptions = (await latestContent(db, a.sourceVideoId, "captions"))?.body as { timings_kind?: unknown } | undefined;

  const result: ClipShortsResult = { created: [], skipped: [] };
  for (const id of ids) {
    const clip = byId.get(id)!;
    const inherited = inheritClipScript({ claims }, clip);
    if (!inherited.ok) {
      result.skipped.push({ clipId: id, reason: inherited.reason });
      continue;
    }
    const videoId = uuidv7();
    // The file first: nothing is created for a clip whose file cannot be copied. Then the row (the unique index makes a second request for the same clip a no-op).
    let dir = "";
    try {
      dir = await safeJoin(a.root, "videos", videoId);
      await mkdir(dir, { recursive: true });
      await copyRegular(await safeJoin(a.root, "videos", a.sourceVideoId, clip.file), path.join(dir, "final.mp4"));
    } catch {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      result.skipped.push({ clipId: id, reason: "The clip file could not be copied." });
      continue;
    }
    const ins = await db.query(
      `insert into videos (id, format, kind, language, topic, channel_id, style, caption_style, clip_of, clip_batch, clip_id, clip_start_ms, clip_end_ms)
       values ($1, 'short', 'tsx', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict do nothing`,
      [videoId, src.language, inherited.value.script.title, src.channel_id, src.style, src.caption_style, a.sourceVideoId, a.batch, id, Math.round(clip.startS * 1000), Math.max(Math.round(clip.startS * 1000) + 1, Math.round(clip.endS * 1000))],
    );
    if (!ins.rowCount) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      result.skipped.push({ clipId: id, reason: "A Short was already made from this clip." });
      continue;
    }
    try {
      const put = (kind: ContentKind, body: unknown) => addContent(db, videoId, kind, { body, sha256: sha256Hex(canonicalJson(body)) }); // produced_by stays null: a clip's content has no producing stage run (the beats still match the script)
      const { script } = inherited.value;
      await put("script", script);
      await put("beats", { beats: script.beats });
      await put("evidence", { claims: script.evidence });
      await put("captions", { timings_kind: typeof sourceCaptions?.timings_kind === "string" ? sourceCaptions.timings_kind : "aligned", words: clip.words, needs_check: false, flags: [], approximate: false });
    } catch (e) {
      await db.query("update videos set status = 'cancelled' where id = $1", [videoId]).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
    await recordAudit(db, "clips.short_created", { videoId, sourceVideoId: a.sourceVideoId, batch: a.batch, clipId: id, leftOutClaims: inherited.value.leftOutClaims, sessionId: a.sessionId });
    await advanceVideo(db, queue, videoId, approvalReaders).catch(() => undefined); // best effort: the worker's sweep picks it up
    result.created.push({ clipId: id, videoId });
  }
  return { ok: true, ...result };
}
