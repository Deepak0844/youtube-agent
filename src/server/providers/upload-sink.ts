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

export async function sinkUpload(
  body: ReadableStream<Uint8Array>,
  opts: { dir: string; maxBytes: number; signal?: AbortSignal },
): Promise<{ id: string; bytes: number; sha256: string }> {
  await mkdir(opts.dir, { recursive: true });
  const id = randomUUID();
  const tmp = path.join(opts.dir, `${id}.part`);
  const hash = createHash("sha256");
  let bytes = 0;
  const gate = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > opts.maxBytes) return cb(new UploadTooLargeError(opts.maxBytes));
      hash.update(chunk);
      cb(null, chunk);
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
