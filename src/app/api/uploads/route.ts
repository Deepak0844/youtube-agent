import { randomUUID } from "node:crypto";
import path from "node:path";
import { assertSameOrigin } from "@/lib/auth/origin";
import { requireOwnerApi } from "@/lib/auth/require-owner";
import { checkRights, cleanOriginalName, refusalMessage, rightsRequestSchema, stampAttestation, storageFullMessage } from "@/server/core/asset-rules";
import { rejectionMessage, sniff } from "@/server/core/sniff";
import { loadLimits, markQueued, markRejected, reserveIngestJob } from "@/server/db/ingest-jobs";
import { getPool } from "@/server/db/pool";
import { sinkUpload, UploadTooLargeError } from "@/server/providers/upload-sink";
import { createJobQueue, type IngestQueue } from "@/server/queue/job-queue";
import { storageRoot } from "@/server/storage/paths";

// Streaming upload, deliberately OUTSIDE proxy.ts (the proxy buffers bodies up to 10 MB), so this handler does the
// session check and Host/Origin check itself, before a single body byte is read. One file per request.
//
// The web process enforces only byte sizes and counts: content-length is required, the stream is cut at the cap, the first
// 4 KB are sniffed before any more is read, and an unknown type is refused there. It never parses image headers (that is
// the worker's sandboxed ingest job). The file name is metadata only: it is cleaned, stored as text, and never reaches a path.
const noStore = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class Refused extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
const fail = (status: number, error: string, message?: string) => Response.json({ error, ...(message && { message }) }, { status, headers: noStore });

export async function POST(request: Request) {
  const owner = await requireOwnerApi(request); // the route guard checker wants the session check first
  if (owner instanceof Response) return owner;
  const bad = assertSameOrigin(request);
  if (bad) return bad;

  const batchId = new URL(request.url).searchParams.get("batch") ?? "";
  if (!UUID.test(batchId)) return fail(400, "batch_invalid", "The upload needs a batch id.");
  const lengthHeader = request.headers.get("content-length") ?? "";
  if (!/^\d{1,15}$/.test(lengthHeader)) return fail(411, "length_required", "The upload must say how big it is.");
  const declared = Number(lengthHeader);
  if (declared === 0 || !request.body) return fail(400, "empty_body", "The file is empty.");
  let rights;
  try {
    rights = rightsRequestSchema.parse(JSON.parse(request.headers.get("x-rights") ?? ""));
  } catch {
    return fail(400, "rights_invalid", "Confirm that you have the rights to use this file.");
  }

  const pool = getPool();
  const limits = await loadLimits(pool);
  if (declared > Math.max(limits.maxImageBytes, limits.maxAudioBytes)) return fail(413, "too_large", "The file is larger than allowed.");
  const attestation = stampAttestation(rights, new Date()); // the server's clock, never the caller's
  const id = randomUUID();
  const reserved = await reserveIngestJob(
    pool,
    { id, batchId, originalName: cleanOriginalName(decodeName(request.headers.get("x-file-name"))), declaredBytes: declared, tags: rights.tags, caption: rights.caption, keep: rights.keep, containsPerson: rights.contains_person, voiceClone: rights.voice_clone, rights: { attestations: [attestation] } },
    limits,
  );
  if (!reserved.ok) {
    if (reserved.reason === "rate_limited") return fail(429, "rate_limited", "Too many uploads at once. Wait a minute and try again.");
    if (reserved.reason === "too_many_files") return fail(409, "too_many_files", "A batch can hold at most " + limits.maxBatchFiles + " files.");
    if (reserved.reason === "storage_full") return fail(507, "storage_full", storageFullMessage(reserved.holders!));
    return fail(413, "too_large", "The file is larger than allowed.");
  }

  let kind: "image" | "audio" = "image";
  try {
    const r = await sinkUpload(request.body, {
      dir: path.join(storageRoot(), "assets-incoming"),
      id,
      maxBytes: declared,
      signal: request.signal,
      onHead(head) {
        const s = sniff(head);
        if ("rejected" in s) throw new Refused(rejectionMessage(s.rejected), 415);
        kind = s.kind;
        const verdict = checkRights({ attestations: [attestation] }, { kind, tags: rights.tags, containsPerson: rights.contains_person, voiceCloneReference: rights.voice_clone });
        if (!verdict.ok) throw new Refused(refusalMessage(verdict.reason), 422);
        const cap = kind === "image" ? limits.maxImageBytes : limits.maxAudioBytes;
        if (declared > cap) throw new UploadTooLargeError(cap);
        return declared;
      },
    });
    await markQueued(pool, id, kind, r.bytes);
    await enqueue(id);
    return Response.json({ id, status: "queued" }, { status: 201, headers: noStore });
  } catch (err) {
    const refused = err instanceof Refused ? err : err instanceof UploadTooLargeError ? new Refused("The file is larger than allowed.", 413) : null;
    await markRejected(pool, id, refused?.message ?? "The upload was interrupted. Try again.").catch(() => undefined);
    return refused ? fail(refused.status, refused.status === 413 ? "too_large" : "rejected", refused.message) : fail(500, "upload_failed");
  }
}

// x-file-name arrives percent-encoded (headers are latin-1); a malformed encoding is used as sent.
function decodeName(raw: string | null): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Redis down or unset: the row stays `queued` and the worker's sweep picks it up, so the upload itself still succeeds.
let queue: IngestQueue | undefined;
async function enqueue(id: string): Promise<void> {
  try {
    if (!process.env.REDIS_URL) return;
    queue ??= createJobQueue(process.env.REDIS_URL, "ingest");
    // Bounded: a Redis that accepts the connection but never answers must not hold the upload response.
    await Promise.race([queue.enqueueIngest(id), new Promise((_, no) => setTimeout(no, 2000).unref())]);
  } catch {
    /* the worker's sweep re-enqueues queued rows */
  }
}
