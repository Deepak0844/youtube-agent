import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { normalizeRelPath, safeJoin } from "./paths";

// Hashes the REAL bytes of a stored file, so an approval or an upload is bound to what is on disk and not to a number
// somebody wrote in a table. The path is a strict relative path under the storage root (safeJoin proves it cannot leave),
// the final component is opened with O_NOFOLLOW, and only a regular file counts. Errors are plain and carry no path.

export class StoredFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredFileError";
  }
}

export async function hashStoredFile(root: string, relPath: string): Promise<{ sha256: string; bytes: number }> {
  if (normalizeRelPath(relPath) === null) throw new StoredFileError("the file path is not a valid storage path");
  let abs: string;
  try {
    abs = await safeJoin(root, relPath);
  } catch {
    throw new StoredFileError("the file is outside the storage folder");
  }
  let fh;
  try {
    fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new StoredFileError("the file cannot be opened");
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new StoredFileError("the file is not a regular file");
    const h = createHash("sha256");
    let bytes = 0;
    for await (const chunk of fh.createReadStream({ autoClose: false })) {
      h.update(chunk as Buffer);
      bytes += (chunk as Buffer).length;
    }
    return { sha256: h.digest("hex"), bytes };
  } catch (err) {
    if (err instanceof StoredFileError) throw err;
    throw new StoredFileError("the file cannot be read");
  } finally {
    await fh.close().catch(() => undefined);
  }
}
