import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { normalizeRelPath, safeJoin } from "./paths";

// Reads the REAL bytes of a stored file, so an approval or an upload is bound to what is on disk and not to a number
// somebody wrote in a table. The path is a strict relative path under the storage root (safeJoin proves it cannot leave).
// It is lstat-ed first (only a regular file, never a link, FIFO or device), opened with O_NOFOLLOW | O_NONBLOCK (a FIFO
// swapped in after the check cannot block the open), fstat-ed again, size-capped and time-boxed. Errors are plain and
// carry no path.

export class StoredFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredFileError";
  }
}

export const MAX_FILE_BYTES = 8 * 1024 ** 3;
export const READ_TIMEOUT_MS = 10 * 60_000;
export interface ReadLimits {
  maxBytes?: number;
  timeoutMs?: number;
}

async function openRegular(root: string, relPath: string, maxBytes: number): Promise<FileHandle> {
  if (normalizeRelPath(relPath) === null) throw new StoredFileError("the file path is not a valid storage path");
  let abs: string;
  try {
    abs = await safeJoin(root, relPath);
  } catch {
    throw new StoredFileError("the file is outside the storage folder");
  }
  try {
    const l = await lstat(abs);
    if (!l.isFile()) throw new StoredFileError("the file is not a regular file");
  } catch (e) {
    if (e instanceof StoredFileError) throw e;
    throw new StoredFileError("the file cannot be opened");
  }
  let fh: FileHandle;
  try {
    fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new StoredFileError("the file cannot be opened");
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new StoredFileError("the file is not a regular file");
    if (st.size > maxBytes) throw new StoredFileError("the file is larger than allowed");
    return fh;
  } catch (e) {
    await fh.close().catch(() => undefined);
    throw e instanceof StoredFileError ? e : new StoredFileError("the file cannot be read");
  }
}

export async function hashStoredFile(root: string, relPath: string, limits: ReadLimits = {}): Promise<{ sha256: string; bytes: number }> {
  const maxBytes = limits.maxBytes ?? MAX_FILE_BYTES;
  const fh = await openRegular(root, relPath, maxBytes);
  const stream = fh.createReadStream({ autoClose: false });
  const timer = setTimeout(() => stream.destroy(new StoredFileError("reading the file took too long")), limits.timeoutMs ?? READ_TIMEOUT_MS);
  try {
    const h = createHash("sha256");
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += (chunk as Buffer).length;
      if (bytes > maxBytes) throw new StoredFileError("the file is larger than allowed");
      h.update(chunk as Buffer);
    }
    return { sha256: h.digest("hex"), bytes };
  } catch (err) {
    if (err instanceof StoredFileError) throw err;
    throw new StoredFileError("the file cannot be read");
  } finally {
    clearTimeout(timer);
    stream.destroy();
    await fh.close().catch(() => undefined);
  }
}

/**
 * The bytes an uploader must send. The stream hashes what it delivers and ERRORS at the end if the digest or the length
 * differs from `expect` (the values verified for the approval), so a file swapped after the job-time check cannot be
 * sent as if it were the approved one without the uploader being told. The uploader must treat that error as a failed
 * upload and, if bytes already left, as "check YouTube Studio first".
 */
export async function openStoredFile(root: string, relPath: string, expect: { sha256: string; bytes: number }, limits: ReadLimits = {}): Promise<Readable> {
  const maxBytes = limits.maxBytes ?? MAX_FILE_BYTES;
  const fh = await openRegular(root, relPath, maxBytes);
  const h = createHash("sha256");
  let bytes = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes || bytes > expect.bytes) return cb(new StoredFileError("the file changed after it was approved"));
      h.update(chunk);
      cb(null, chunk);
    },
    flush(cb) {
      cb(bytes === expect.bytes && h.digest("hex") === expect.sha256 ? null : new StoredFileError("the file changed after it was approved"));
    },
  });
  const source = fh.createReadStream({ autoClose: true });
  const timer = setTimeout(() => check.destroy(new StoredFileError("reading the file took too long")), limits.timeoutMs ?? READ_TIMEOUT_MS);
  check.on("close", () => clearTimeout(timer));
  source.on("error", (e) => check.destroy(e));
  return source.pipe(check);
}
