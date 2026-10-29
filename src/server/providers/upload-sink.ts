import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// Streams a request body to disk with a hard byte cap and a sha256, never buffering the whole file (the proxy buffers
// bodies up to 10 MB, which is why /api/uploads is outside it). Writes to a temp name and renames on success, so a
// cut-off or oversized upload never leaves a file that looks complete.

export class UploadTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`upload exceeds ${maxBytes} bytes`);
    this.name = "UploadTooLargeError";
  }
}

const HEAD_BYTES = 4096;

/**
 * `onHead` sees the first 4 KB (or the whole file when shorter) before anything more is read or written. It returns the
 * byte cap for the rest of the file, or throws to reject it; a throw stops the stream and removes the partial file.
 */
export async function sinkUpload(
  body: ReadableStream<Uint8Array>,
  opts: { dir: string; maxBytes: number; id?: string; onHead?: (head: Uint8Array) => number; signal?: AbortSignal },
): Promise<{ id: string; bytes: number; sha256: string }> {
  await mkdir(opts.dir, { recursive: true });
  const id = opts.id ?? randomUUID();
  const tmp = path.join(opts.dir, `${id}.part`);
  const hash = createHash("sha256");
  let bytes = 0;
  let cap = opts.maxBytes;
  let held: Buffer[] = [];
  let heldLen = 0;
  let sniffed = !opts.onHead;
  // Runs the head check once and releases what was held back. Throws if rejected or already over the new cap.
  const release = (): Buffer => {
    const head = Buffer.concat(held);
    held = [];
    sniffed = true;
    cap = Math.min(cap, opts.onHead!(head.subarray(0, HEAD_BYTES)));
    if (bytes > cap) throw new UploadTooLargeError(cap);
    return head;
  };
  const gate = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > cap) return cb(new UploadTooLargeError(cap));
      hash.update(chunk);
      if (sniffed) return cb(null, chunk);
      held.push(chunk);
      heldLen += chunk.length;
      if (heldLen < HEAD_BYTES) return cb();
      try {
        cb(null, release());
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb) {
      try {
        if (!sniffed) this.push(release());
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
  });
  try {
    const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(source, gate, createWriteStream(tmp, { flags: "wx" }), { signal: opts.signal });
    await rename(tmp, path.join(opts.dir, id));
    return { id, bytes, sha256: hash.digest("hex") };
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
