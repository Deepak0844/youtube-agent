import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { uuidv7 } from "@/server/core/ids";
import { UPLOAD_FILE } from "@/server/core/source-ingest";
import { safeJoin } from "@/server/storage/paths";
import { recordAudit } from "./audit";
import type { EnqueueOnly } from "./pipeline";

export const SOURCE_NOTE = "Uploaded video (clip source)";

export type ClipSourceResult = { ok: true; videoId: string; stageRunId: string } | { ok: false; message: string };

const LANGS = new Set(["en", "hi", "ta", "te", "ml", "kn"]);

/**
 * The owner uploaded a video to cut clips from (Clip Factory, upload source). `tempFile` is the finished upload inside the storage root (the
 * upload route wrote it, size-capped). This moves it next to a NEW video row and queues the on-demand `ingest_source` step, which checks and
 * re-encodes the file, listens to it (VoiceStudio speech-to-text) and saves the words. The row is `done` from the start, so the production
 * pipeline never drafts, narrates or renders anything for it: it exists only to be cut into clips. Nothing is published or approved here.
 * The caller (the owner's upload route) must require a signed-in session and the Origin check; this function checks neither.
 */
export async function createClipSource(
  db: pg.Pool,
  queue: EnqueueOnly,
  a: { root: string; tempFile: string; sizeBytes: number; fileName: string; language: string; channelId?: string | null; sessionId?: string },
): Promise<ClipSourceResult> {
  if (!LANGS.has(a.language)) return { ok: false, message: "Choose the language spoken in the video." };
  if (!Number.isFinite(a.sizeBytes) || a.sizeBytes <= 0) return { ok: false, message: "The upload is empty." };
  const videoId = uuidv7();
  const topic = path.basename(a.fileName).replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120) || "Uploaded video";
  let dest = "";
  try {
    dest = await safeJoin(a.root, "videos", videoId, UPLOAD_FILE);
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(a.tempFile, dest);
  } catch {
    await rm(path.dirname(dest || a.root + "/x"), { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, message: "The upload could not be stored." };
  }
  const stageRunId = uuidv7();
  const hash = sha256Hex(canonicalJson({ stage: "ingest_source", video: videoId }));
  try {
    await db.query("insert into videos (id, format, kind, language, topic, notes, channel_id, status) values ($1, 'short', 'tsx', $2, $3, $4, $5, 'done')", [videoId, a.language, topic, SOURCE_NOTE, a.channelId ?? null]);
    await db.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1, $2, 'ingest_source', 'queued', $3)", [stageRunId, videoId, hash]);
  } catch (e) {
    await rm(path.dirname(dest), { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  await recordAudit(db, "clips.source_uploaded", { videoId, sizeBytes: a.sizeBytes, sessionId: a.sessionId });
  await queue.enqueue(stageRunId, 0, 0, hash).catch(() => undefined); // if Redis is down the row stays queued and the reconciler enqueues it
  return { ok: true, videoId, stageRunId };
}
