// The real YouTube uploader: Data API v3 resumable upload. Money/publish path, so the outcome rules are strict:
//   - A clear rejection (HTTP 4xx from Google, nothing finalised) returns `failed` with a plain reason: a human may retry.
//   - After the first byte is allowed to leave (we report 1 byte of progress BEFORE the first chunk), ANY unclear end
//     (timeout, socket reset, 5xx, 408, a lost or unreadable final answer) THROWS. The upload job then records "check YouTube
//     Studio first" and nothing ever re-sends on its own.
//   - The final chunk is sent only after the approved file was read to its end and its hash and length matched. A swapped
//     file therefore never completes a video (the session is left unfinished) and is a clear `failed`.
//   - Only `target.open()` is read. All HTTP goes through the injected `http` (default: safeFetch, indirect mode).
// Secrets: the access token and the session URI are never put in an error message, an audit row or a log. The session URI is
// kept in the vault so a human-triggered "check" can look for the video; nothing resumes it automatically.
import type pg from "pg";
import type { Keyring } from "@/server/core/vault-crypto";
import { quotaCost } from "@/server/core/youtube-oauth";
import { getAccessToken, reserveQuota, type GoogleHttp } from "@/server/db/youtube-channels";
import { putSecret } from "@/server/db/vault";
import { safeFetch } from "@/server/providers/net/safe-fetch";
import type { Uploader, UploadOutcome, UploadTarget } from "./index";

const API = "https://www.googleapis.com";
const INIT_URL = `${API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`;
const SESSION_PREFIX = `${API}/upload/youtube/v3/videos?`;
export const CHUNK_BYTES = 8 * 1024 * 1024; // a multiple of 256 KiB, as the resumable protocol requires
export const sessionSecretName = (uploadId: string) => `youtube.upload.${uploadId}.session`;

/** Longer than the OAuth default: one chunk is several MiB. */
export const uploadHttp: GoogleHttp = (url, init) => safeFetch(url, init, { mode: "indirect", timeoutMs: 120_000 });

export interface YouTubeUploaderDeps {
  pool: pg.Pool;
  ring: Keyring | (() => Keyring);
  http?: GoogleHttp;
  chunkBytes?: number;
}

/** Thrown for any end we cannot call clear. The message is fixed text: it ends up in the owner's screen and the audit log. */
class Unclear extends Error {
  constructor(msg = "YouTube did not confirm the upload (network or server trouble)") {
    super(msg);
  }
}
class Rejected extends Error {}

const REASONS: Record<string, string> = {
  quotaExceeded: "YouTube says the daily quota is used up",
  uploadLimitExceeded: "YouTube says the channel hit its daily upload limit",
  forbidden: "YouTube refused: this account may not upload to this channel",
  unauthorized: "YouTube refused the sign-in; reconnect the channel",
  invalidMetadata: "YouTube refused the title, description or tags",
  invalidTags: "YouTube refused the tags",
  invalidTitle: "YouTube refused the title",
  invalidDescription: "YouTube refused the description",
  invalidPublishAt: "YouTube refused the publish time",
  mediaBodyRequired: "YouTube found no video data",
  youtubeSignupRequired: "this Google account has no YouTube channel",
};

async function rejectionOf(res: Response): Promise<Rejected> {
  let reason = "";
  try {
    const j = (await res.json()) as { error?: { errors?: Array<{ reason?: unknown }> } };
    const r = j?.error?.errors?.[0]?.reason;
    if (typeof r === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(r)) reason = r;
  } catch {
    // no readable body: the status alone is the reason
  }
  return new Rejected(REASONS[reason] ?? `YouTube refused the upload (HTTP ${res.status}${reason ? `, ${reason}` : ""})`);
}

export function createYouTubeUploader(deps: YouTubeUploaderDeps): Uploader {
  const http = deps.http ?? uploadHttp;
  const chunkBytes = deps.chunkBytes ?? CHUNK_BYTES;
  const ring = typeof deps.ring === "function" ? deps.ring() : deps.ring;

  async function send(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      return await http(url, { ...init, signal });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new Unclear();
    }
  }

  return {
    async upload(uploadId, onProgress, signal, target?: UploadTarget): Promise<UploadOutcome> {
      if (!target) return { kind: "failed", reason: "no approved file was handed to the uploader" };
      if (!Number.isSafeInteger(target.bytes) || target.bytes < 1) return { kind: "failed", reason: "the approved video file is empty" };
      try {
        // 1. token (not a YouTube call), then the quota reservation, BEFORE the insert call
        const tok = await getAccessToken(deps.pool, deps.ring, http, target.channelRowId);
        if (!tok.ok) {
          return { kind: "failed", reason: tok.reason === "unavailable" ? "could not get a YouTube sign-in right now; try again" : "the channel needs to be reconnected or confirmed (Settings, Channels)" };
        }
        const auth = { authorization: `Bearer ${tok.accessToken}` };
        if (!(await reserveQuota(deps.pool, "videos.insert"))) return { kind: "failed", reason: `not enough YouTube quota left today (this upload costs ${quotaCost("videos.insert")} units)` };

        // 2. open the resumable session
        const d = target.details;
        const status: Record<string, unknown> = { privacyStatus: target.visibility, selfDeclaredMadeForKids: d.madeForKids, containsSyntheticMedia: d.synthetic };
        if (target.visibility === "private" && target.publishAt !== null) status.publishAt = new Date(target.publishAt).toISOString();
        const init = await send(INIT_URL, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json; charset=UTF-8", "x-upload-content-length": String(target.bytes), "x-upload-content-type": "video/mp4" },
          body: JSON.stringify({ snippet: { title: d.title, description: d.description, tags: d.tags, categoryId: String(d.categoryId), defaultLanguage: d.language }, status }),
        }, signal);
        if (init.status >= 400 && init.status < 500) throw await rejectionOf(init);
        const session = init.headers.get("location");
        if (!init.ok || !session || !session.startsWith(SESSION_PREFIX)) return { kind: "failed", reason: "YouTube did not open an upload session; nothing was sent" };
        try {
          await putSecret(deps.pool, ring, sessionSecretName(uploadId), session, { hint: false });
        } catch {
          return { kind: "failed", reason: "could not store the upload session safely; nothing was sent" };
        }

        // 3. From here a failure may leave a live video. 1 byte of progress now makes the job treat any throw as "check Studio first".
        await onProgress(1);
        const put = async (data: Buffer, start: number, last: boolean): Promise<string | null> => {
          const end = start + data.length - 1;
          const res = await send(session, {
            method: "PUT",
            headers: { "content-length": String(data.length), "content-range": `bytes ${start}-${end}/${target.bytes}`, "content-type": "video/mp4" },
            body: data as unknown as BodyInit,
          }, signal);
          if (last) {
            if (res.status === 200 || res.status === 201) {
              const id = ((await res.json().catch(() => null)) as { id?: unknown } | null)?.id;
              if (typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id)) return id;
              throw new Unclear("YouTube accepted the upload but its answer had no video id");
            }
          } else if (res.status === 308) {
            const m = /^bytes=0-(\d+)$/.exec(res.headers.get("range") ?? "");
            if (!m || Number(m[1]) !== end) throw new Unclear("YouTube kept less data than was sent");
            return null;
          }
          if (res.status >= 400 && res.status < 500 && res.status !== 408) throw await rejectionOf(res);
          throw new Unclear();
        };

        // 4. stream only target.open(); a full buffer is held back until more data (or the verified end) arrives, so the
        //    final chunk is always sent after the stream ended cleanly (hash and length matched).
        const src = await target.open();
        let held: Buffer = Buffer.alloc(0);
        let sent = 0;
        let youtubeId: string | null = null;
        try {
          for await (const c of src) {
            held = Buffer.concat([held, c as Buffer]);
            while (held.length > chunkBytes) {
              await put(held.subarray(0, chunkBytes), sent, false);
              sent += chunkBytes;
              held = held.subarray(chunkBytes);
              await onProgress(sent);
            }
          }
        } catch (e) {
          if (e instanceof Unclear || e instanceof Rejected || signal.aborted) throw e;
          // the file stream itself failed or its hash/length check failed: the last chunk was never sent, so no video exists
          src.destroy();
          return { kind: "failed", reason: "the video file changed after it was approved; nothing was published" };
        }
        if (sent + held.length !== target.bytes) return { kind: "failed", reason: "the video file changed after it was approved; nothing was published" };
        youtubeId = await put(held, sent, true);
        if (youtubeId === null) throw new Unclear();
        await onProgress(target.bytes).catch(() => undefined);

        // 5. read back what YouTube actually kept (an unaudited project may be forced to private). A failed read-back never
        //    undoes the success: the video exists.
        await readBack(deps.pool, http, auth, signal, uploadId, youtubeId, target.visibility);
        return { kind: "uploaded", youtubeId };
      } catch (e) {
        if (e instanceof Rejected) return { kind: "failed", reason: e.message };
        throw e;
      }
    },
  };
}

async function note(pool: pg.Pool, uploadId: string, event: string): Promise<void> {
  await pool.query("insert into upload_log (upload_id, event) values ($1, $2)", [uploadId, event]).catch(() => undefined);
}

async function readBack(pool: pg.Pool, http: GoogleHttp, auth: Record<string, string>, signal: AbortSignal, uploadId: string, ytId: string, approved: string): Promise<void> {
  try {
    if (!(await reserveQuota(pool, "videos.list"))) return void (await note(pool, uploadId, "readback_skipped: quota"));
    const res = await http(`${API}/youtube/v3/videos?part=status&id=${encodeURIComponent(ytId)}`, { headers: auth, signal });
    const j = res.ok ? ((await res.json()) as { items?: Array<{ status?: { privacyStatus?: unknown } }> }) : null;
    const p = j?.items?.[0]?.status?.privacyStatus;
    if (typeof p !== "string" || !/^[a-z]{1,20}$/.test(p)) return void (await note(pool, uploadId, "readback_failed"));
    await note(pool, uploadId, p === approved ? `readback_ok: ${p}` : `privacy_mismatch: approved=${approved} reported=${p}`);
  } catch {
    await note(pool, uploadId, "readback_failed");
  }
}
