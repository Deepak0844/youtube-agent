import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { assertSameOrigin } from "@/lib/auth/origin";
import { requireOwnerApi } from "@/lib/auth/require-owner";
import { looksLikeVideo, SOURCE_MAX_BYTES } from "@/server/core/source-ingest";
import { createClipSource } from "@/server/db/clip-source";
import { getPool } from "@/server/db/pool";
import { sinkUpload, UploadTooLargeError } from "@/server/providers/upload-sink";
import { webStageQueue } from "@/server/queue/web-queues";
import { storageRoot } from "@/server/storage/paths";

// Clip Factory: a video file to cut clips from, streamed to disk (deliberately OUTSIDE proxy.ts, which buffers bodies up to 10 MB), so this handler
// does the session check and the Host/Origin check itself before a single body byte is read. One file per request, at most 1 GiB, and its first
// bytes must look like an mp4/mov/mkv/webm. The file is untrusted: the worker's ingest step probes it, re-encodes it and deletes it (createClipSource).
const LANGUAGES = new Set(["en", "hi", "ta", "te", "ml", "kn"]);
const noStore = { "cache-control": "no-store" };
const fail = (status: number, error: string, message: string) => Response.json({ error, message }, { status, headers: noStore });

class Refused extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function POST(request: Request) {
  const owner = await requireOwnerApi(request); // the route guard checker wants the session check first
  if (owner instanceof Response) return owner;
  const bad = assertSameOrigin(request);
  if (bad) return bad;

  const language = new URL(request.url).searchParams.get("language") ?? "";
  if (!LANGUAGES.has(language)) return fail(400, "language_invalid", "Choose the language spoken in the video."); // before a single body byte is read
  const lengthHeader = request.headers.get("content-length") ?? "";
  if (!/^\d{1,15}$/.test(lengthHeader)) return fail(411, "length_required", "The upload must say how big it is.");
  const declared = Number(lengthHeader);
  if (declared === 0 || !request.body) return fail(400, "empty_body", "The file is empty.");
  if (declared > SOURCE_MAX_BYTES) return fail(413, "too_large", "The file is over 1 GB.");

  const id = randomUUID();
  const dir = path.join(storageRoot(), "clip-incoming");
  try {
    const r = await sinkUpload(request.body, {
      dir,
      id,
      maxBytes: declared,
      signal: request.signal,
      onHead(head) {
        if (!looksLikeVideo(head)) throw new Refused("This is not an mp4, mov, mkv or webm video.", 415);
        return declared;
      },
    });
    const made = await createClipSource(getPool(), webStageQueue(), { root: storageRoot(), tempFile: path.join(dir, id), sizeBytes: r.bytes, fileName: decodeName(request.headers.get("x-file-name")), language, sessionId: owner.sessionId });
    if (!made.ok) {
      await rm(path.join(dir, id), { force: true }).catch(() => undefined);
      return fail(422, "rejected", made.message);
    }
    return Response.json({ videoId: made.videoId, status: "queued" }, { status: 201, headers: noStore });
  } catch (err) {
    await rm(path.join(dir, id), { force: true }).catch(() => undefined);
    await rm(path.join(dir, `${id}.part`), { force: true }).catch(() => undefined);
    if (err instanceof Refused) return fail(err.status, "rejected", err.message);
    if (err instanceof UploadTooLargeError) return fail(413, "too_large", "The file is larger than it said.");
    return fail(500, "upload_failed", "The upload was interrupted. Try again.");
  }
}

// x-file-name arrives percent-encoded (headers are latin-1); a malformed encoding is used as sent. It is metadata only and never reaches a path.
function decodeName(raw: string | null): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
