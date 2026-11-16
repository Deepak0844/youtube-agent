import { constants as fsc } from "node:fs";
import { lstat, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";

// Reading and copying files the app did not make (render output, model-chosen paths) without trusting them: no symlink followed, no
// FIFO opened blocking, sizes capped. Used by the worker stages, the renderers and db code; none of it depends on any of them.

export const MAX_VIDEO_BYTES = 2 * 1024 ** 3;

/** Opens a regular file for reading: no symlink followed, and O_NONBLOCK so a planted FIFO cannot hang the open. */
export async function openRegular(file: string) {
  const fh = await open(file, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  try {
    if (!(await fh.stat()).isFile()) throw new KnownFailure("expected a regular file");
    return fh;
  } catch (e) {
    await fh.close();
    throw e;
  }
}

/**
 * Copies a regular file (no symlink followed, no FIFO opened blocking) to dest, readable by the container user. Reads at most
 * maxBytes + 1 bytes, so a file still growing cannot push the copy past the cap; a bigger file is refused and the partial copy removed.
 */
export async function copyRegular(src: string, dest: string, maxBytes = MAX_VIDEO_BYTES): Promise<void> {
  const st = await lstat(src).catch(() => null);
  if (!st?.isFile()) throw new KnownFailure(`The file ${path.basename(src)} is missing or not a plain file.`);
  let fh;
  try {
    fh = await openRegular(src);
  } catch {
    throw new KnownFailure(`The file ${path.basename(src)} is missing or not a plain file.`);
  }
  let n = 0;
  const tooBig = () => new KnownFailure(`The file ${path.basename(src)} is bigger than ${maxBytes} bytes.`);
  try {
    if ((await fh.stat()).size > maxBytes) throw tooBig();
    const stream = fh.createReadStream({ autoClose: false, end: maxBytes }); // end is inclusive: at most maxBytes + 1 bytes
    await writeFile(dest, (async function* () {
      for await (const chunk of stream) {
        n += (chunk as Buffer).length;
        if (n > maxBytes) throw tooBig();
        yield chunk as Buffer;
      }
    })(), { mode: 0o644, flag: "wx" });
  } catch (e) {
    if (n > 0) await rm(dest, { force: true });
    throw e;
  } finally {
    await fh.close();
  }
}
